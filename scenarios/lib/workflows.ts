/** What the scenarios read from a workflow file, by line; no YAML parser. */
export interface WorkflowRead {
  /** Top-level `name:`, unquoted or read as a block scalar; undefined when absent. */
  name?: string;
  /** Top-level `run-name:`, unquoted or read as a block scalar; undefined when absent. */
  runName?: string;
  /** Every `uses:` value. */
  uses: string[];
  /** Every `ghcr.io/taco3064/nibfin…` reference. */
  images: string[];
  /** Every `runs-on:` value, with the lines of a block list or mapping below it joined in. */
  runsOn: string[];
}

const unquote = (v: string) => {
  const t = v.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
};

const indent = (l: string) => l.length - l.trimStart().length;

const BLOCK_HEADER = /^([|>])(?:([1-9])([-+])?|([-+])([1-9])?)?\s*(?:#.*)?$/;

/**
 * Reads the block scalar (`|` or `>`, with an optional chomping indicator and indentation
 * digit) whose header ends line `at`: the following lines that are blank or indented, up
 * to the next non-blank line at column 0. A folded block joins adjacent lines with a
 * space and turns a blank line into a newline; clip keeps one final newline.
 */
function blockScalar(header: string, lines: string[], at: number): string | undefined {
  const h = BLOCK_HEADER.exec(header);
  if (!h) return undefined;
  const folded = h[1] === '>';
  const digit = h[2] ?? h[5];
  const chomp = h[3] ?? h[4] ?? '';
  const raw: string[] = [];
  for (let j = at + 1; j < lines.length; j++) {
    const l = lines[j] as string;
    if (l.trim() !== '' && indent(l) === 0) break;
    raw.push(l);
  }
  const first = raw.find((l) => l.trim() !== '');
  const n = digit ? Number(digit) : first ? indent(first) : 0;
  const body = raw.map((l) => (l.trim() === '' ? '' : l.slice(n)));
  let trailing = 0;
  while (body.length && body[body.length - 1] === '') {
    body.pop();
    trailing++;
  }
  let text = '';
  body.forEach((l, k) => {
    if (k === 0) text = l;
    else if (!folded) text += '\n' + l;
    else if (l === '') text += '\n';
    else text += (body[k - 1] === '' ? '' : ' ') + l;
  });
  if (chomp === '+') return (body.length ? text + '\n' : '') + '\n'.repeat(trailing);
  return chomp === '-' || !body.length ? text : text + '\n';
}

/** A top-level scalar key's value: a block scalar when its header says so, else unquoted. */
const scalar = (value: string, lines: string[], at: number) => blockScalar(value, lines, at) ?? unquote(value);

export function readWorkflow(text: string): WorkflowRead {
  const lines = text.split(/\r?\n/);
  const out: WorkflowRead = { uses: [], images: [], runsOn: [] };
  lines.forEach((line, i) => {
    let m: RegExpExecArray | null;
    if ((m = /^name:\s*(.*?)\s*$/.exec(line))) out.name ??= scalar(m[1] as string, lines, i);
    if ((m = /^run-name:\s*(.*?)\s*$/.exec(line))) out.runName ??= scalar(m[1] as string, lines, i);
    if ((m = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line))) out.uses.push(unquote(m[1] as string));
    if ((m = /^(\s*)(?:-\s+)?runs-on:\s*(.*?)\s*$/.exec(line))) {
      const base = indent(line);
      const parts = [m[2] as string];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] as string;
        if (next.trim() === '' || next.trim().startsWith('#')) continue;
        if (indent(next) <= base) break;
        parts.push(next.trim());
      }
      out.runsOn.push(parts.filter(Boolean).join(' '));
    }
  });
  for (const m of text.matchAll(/ghcr\.io\/taco3064\/nibfin[^\s"'`]*/g)) out.images.push(m[0]);
  return out;
}

/**
 * The event names of a workflow's top-level `on:`: a scalar (`on: push`), a flow list or
 * mapping (`on: [a, b]`, `on: { a: … }`), or a block mapping or list below it.
 */
export function triggers(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^(?:on|"on"|'on'):(?:\s|$)/.test(l));
  if (at < 0) return [];
  const clean = (l: string) => l.replace(/(^|\s+)#.*$/, '').trim();
  let value = clean((lines[at] as string).replace(/^[^:]+:/, ''));
  if (value.startsWith('[') || value.startsWith('{')) {
    // A flow collection may continue on the following lines until it closes.
    const close = value.startsWith('[') ? ']' : '}';
    for (let j = at + 1; j < lines.length && !value.endsWith(close); j++) value += ' ' + clean(lines[j] as string);
    return value
      .slice(1, value.endsWith(']') || value.endsWith('}') ? -1 : undefined)
      .split(',')
      .map((p) => unquote(p.replace(/:.*$/, '')))
      .filter(Boolean);
  }
  if (value) return [unquote(value)];
  const out: string[] = [];
  let level: number | undefined;
  for (let j = at + 1; j < lines.length; j++) {
    const l = lines[j] as string;
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    if (indent(l) === 0) break;
    level ??= indent(l);
    if (indent(l) !== level) continue;
    const m = /^\s*(?:-\s+(.*?)|(['"]?[\w-]+['"]?)\s*:.*?)\s*$/.exec(l);
    const name = m?.[1] ?? m?.[2];
    if (name) out.push(unquote(name));
  }
  return out;
}

/** Splits an expression at each top-level `op`, outside quotes, parentheses and brackets. */
function splitTop(expr: string, op: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i] as string;
    if (quoted) {
      if (ch === "'") {
        if (expr[i + 1] === "'") i++;
        else quoted = false;
      }
    } else if (ch === "'") quoted = true;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

/** The index of the parenthesis closing the one at `open`, outside quotes; -1 when none. */
function closing(expr: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < expr.length; i++) {
    const ch = expr[i] as string;
    if (quoted) {
      if (ch === "'") {
        if (expr[i + 1] === "'") i++;
        else quoted = false;
      }
    } else if (ch === "'") quoted = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Removes whitespace and parentheses that wrap the whole expression. */
function stripParens(expr: string): string {
  let e = expr.trim();
  while (e.startsWith('(') && closing(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  return e;
}

const STRING = /^'((?:[^']|'')*)'$/;
const unescape = (s: string) => s.replace(/''/g, "'");

/**
 * Whether every title GitHub can render from a `run-name` starts with `prefix`: the value
 * itself starts with it, or it is one `${{ … }}` whose every possible result (the last
 * `&&` term of each `||` operand, the final operand having no `&&`) is a string literal or
 * a `format('<template>', …)` whose text starts with `prefix`.
 */
export function titleStartsWith(runName: string, prefix: string): boolean {
  const t = runName.trim();
  if (t.startsWith(prefix)) return true;
  if (!t.startsWith('${{') || !t.endsWith('}}')) return false;
  const expr = t.slice(3, -2);
  if (expr.includes('${{') || splitTop(expr, '}}').length > 1) return false;

  const leaf = (raw: string): boolean => {
    const e = stripParens(raw);
    const s = STRING.exec(e);
    if (s) return unescape(s[1] as string).startsWith(prefix);
    const f = /^format\s*\(\s*'((?:[^']|'')*)'/i.exec(e);
    const open = e.indexOf('(');
    return !!f && closing(e, open) === e.length - 1 && unescape(f[1] as string).startsWith(prefix);
  };
  const possible = (raw: string): boolean => {
    const e = stripParens(raw);
    const ors = splitTop(e, '||');
    const last = ors[ors.length - 1] as string;
    const earlier = ors.slice(0, -1).every((o) => {
      const ands = splitTop(stripParens(o), '&&');
      return possible(ands[ands.length - 1] as string);
    });
    if (!earlier || splitTop(stripParens(last), '&&').length > 1) return false;
    return ors.length > 1 ? possible(last) : leaf(last);
  };
  return possible(expr);
}

const BARE = 'ghcr.io/taco3064/nibfin';
/** The bare image name, not followed by a tag, digest or longer name. */
const BARE_RE = /ghcr\.io\/taco3064\/nibfin(?![\w@:/.-])/;

/**
 * A line that only assigns the bare image name to a key or variable, `NAME: <bare>` or
 * `NAME=<bare>`, quoted or not; keys that run or pull an image are not names.
 */
const BARE_ASSIGNMENT =
  /^\s*(?:-\s+)?(?:export\s+)?([A-Za-z_][\w-]*)\s*(?::\s+|=)(["']?)ghcr\.io\/taco3064\/nibfin\2\s*(?:#.*)?$/;
const RUNS_IMAGE = new Set(['image', 'container', 'uses', 'run', 'default']);

/** A shell test that only compares two plain values, `[ "$a" != "$b" ]` or `[[ … == … ]]`. */
const COMPARISON =
  /\[\[?\s+(?:"\$\{?[A-Za-z_]\w*\}?"|\$\{?[A-Za-z_]\w*\}?|"[^"$`\\]*"|'[^']*')\s*(?:!=|==|=)\s*(?:"\$\{?[A-Za-z_]\w*\}?"|\$\{?[A-Za-z_]\w*\}?|"[^"$`\\]*"|'[^']*')\s+\]\]?/g;

/**
 * Why a workflow's bare image name may be run, or undefined when it cannot be. The bare
 * name may only be the whole value of a plain assignment (`IMAGE: <bare>`), in this file or
 * a caller (which may pass it in), and each name so assigned may only appear in its own
 * assignment or inside a shell test comparing plain values (as when telling older local
 * images apart). Any other appearance (a command, an expansion, an expression, an output,
 * a matrix value or a comment) could run it, so it fails.
 */
function bareUse(text: string, callerTexts: string[]): string | undefined {
  const lines = text.split(/\r?\n/);
  const names = new Set<string>();
  for (const l of [text, ...callerTexts].flatMap((t) => t.split(/\r?\n/))) {
    const m = BARE_ASSIGNMENT.exec(l);
    if (m && !RUNS_IMAGE.has(m[1] as string)) names.add(m[1] as string);
  }
  for (const l of lines) {
    const m = BARE_ASSIGNMENT.exec(l);
    if (m && names.has(m[1] as string)) continue;
    if (BARE_RE.test(l)) return 'run without a digest';
    const rest = l.replace(COMPARISON, ' ');
    for (const n of names) {
      if (new RegExp(`(?<![\\w-])${n}(?![\\w-])`).test(rest)) return 'run without a digest';
    }
  }
  return undefined;
}

/**
 * The image references of one workflow that break Proposal R5.7, each once, with why.
 * A reference with a digest must be `ghcr.io/taco3064/nibfin@<digest>`; any other
 * reference fails except the bare `ghcr.io/taco3064/nibfin`, which passes only when the
 * expected digest appears in this file or in a file that calls it (`callerTexts`), and
 * the bare name is only assigned and compared, never used in a way that could run it
 * (see `bareUse`): so it is never pulled, run or created by podman, directly or through
 * its variable, nor used as an `image:`, `container:` or `docker://` image.
 */
export function unpinnedImages(
  text: string,
  digest: string,
  callerTexts: string[] = [],
): { ref: string; why?: string }[] {
  const pinned = `${BARE}@${digest}`;
  const out: { ref: string; why?: string }[] = [];
  const refs = new Set(readWorkflow(text).images);
  // A caller may pass the bare name in as an input, so this file is checked for it too.
  if (callerTexts.some((t) => BARE_RE.test(t))) refs.add(BARE);
  for (const ref of refs) {
    if (ref === pinned) continue;
    if (ref !== BARE) {
      out.push({ ref });
      continue;
    }
    if (![text, ...callerTexts].some((t) => t.includes(digest))) {
      out.push({ ref, why: 'with no expected digest in the file or its caller' });
      continue;
    }
    const why = bareUse(text, callerTexts);
    if (why) out.push({ ref, why });
  }
  return out;
}

/**
 * Replaces each exact `ghcr.io/taco3064/nibfin@<from>` reference with `@<to>` and nothing
 * else (Proposal R5.55: the workflow before an upgrade differs only by its image).
 */
export function repin(text: string, from: string, to: string): { text: string; count: number } {
  const ref = `ghcr.io/taco3064/nibfin@${from}`;
  const parts = text.split(ref);
  return { text: parts.join(`ghcr.io/taco3064/nibfin@${to}`), count: parts.length - 1 };
}
