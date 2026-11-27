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
 * The workflow's lines as command lines: each trailing-`\` continuation and each folded
 * `run: >` block joined into one line.
 */
function commandLines(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let foldedAt: number | undefined;
  for (const l of text.split(/\r?\n/)) {
    if (foldedAt !== undefined) {
      if (l.trim() === '' || indent(l) > foldedAt) {
        cur += ' ' + l.trim();
        continue;
      }
      out.push(cur);
      cur = '';
      foldedAt = undefined;
    }
    if (/^\s*(?:-\s+)?run:\s*>[-+1-9]*\s*(?:#.*)?$/.test(l)) {
      out.push(cur + l);
      cur = '';
      foldedAt = indent(l.replace(/^(\s*)-\s+/, '$1  '));
    } else if (/\\\s*$/.test(l)) cur += l.replace(/\\\s*$/, ' ');
    else {
      out.push(cur + l);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The ways a workflow refers to a variable or input `name`: `$name`, `${name}`, `env.name` or `inputs.name`. */
const refersTo = (name: string) => new RegExp(`\\$${name}(?![\\w-])|\\$\\{${name}\\}|\\b(?:env|inputs)\\.${name}(?![\\w-])`);

/**
 * The value lines below a YAML key whose value does not start on its own line: a block
 * scalar (`KEY: |`, `KEY: >-`) or a plain scalar continued on the next, more indented
 * lines. A nested mapping or list below the key is not its value; it yields ''.
 */
function continuation(lines: string[], at: number, m: RegExpMatchArray): string {
  const line = lines[at] as string;
  const rest = line.slice((m.index ?? 0) + m[0].length);
  if (!m[0].endsWith(':') || !/^\s*(?:[|>][-+1-9]*)?\s*(?:#.*)?$/.test(rest)) return '';
  const block = /[|>]/.test(rest);
  const value: string[] = [];
  for (let j = at + 1; j < lines.length; j++) {
    const l = lines[j] as string;
    if (l.trim() === '') continue;
    if (indent(l) <= indent(line)) break;
    if (!block && !value.length && /^\s*(?:-\s|[\w"'-]+\s*:(?:\s|$))/.test(l)) return '';
    value.push(l.trim());
  }
  return ' ' + value.join(' ');
}

/**
 * The names that may hold the bare image name, read across a workflow and the files that
 * call it: every key or variable assigned a value that holds the bare name or refers to
 * another such name, whatever follows it (so `$IMAGE:tag` or `$IMAGE@…` holds it too), and
 * the input an assigned `default:` belongs to.
 */
function bareVariables(texts: string[]): string[] {
  const lines = texts.flatMap((t) => t.split(/\r?\n/));
  const names = new Set<string>();
  const holds = (value: string) => BARE_RE.test(value) || [...names].some((n) => refersTo(n).test(value));
  for (let size = -1; size !== names.size; ) {
    size = names.size;
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/([A-Za-z_][\w-]*)\s*[:=]/g)) {
        if (!holds(l.slice((m.index ?? 0) + m[0].length) + continuation(lines, i, m))) continue;
        names.add(m[1] as string);
        if (m[1] !== 'default') continue;
        for (let j = i - 1; j >= 0; j--) {
          const parent = /^\s*([A-Za-z_][\w-]*):\s*$/.exec(lines[j] as string);
          if (parent && indent(lines[j] as string) < indent(l)) {
            names.add(parent[1] as string);
            break;
          }
        }
      }
    });
  }
  return [...names];
}

/**
 * The image references of one workflow that break Proposal R5.7, each once, with why.
 * A reference with a digest must be `ghcr.io/taco3064/nibfin@<digest>`; any other
 * reference fails except the bare `ghcr.io/taco3064/nibfin`, which passes only when the
 * expected digest appears in this file or in a file that calls it (`callerTexts`), and
 * the bare name (literally or through a variable or input holding it) is never pulled, run or
 * created by podman or another container tool, nor used as an `image:`, `container:` or
 * `docker://` image.
 */
export function unpinnedImages(text: string, digest: string, callerTexts: string[] = []): { ref: string; why?: string }[] {
  const pinned = `${BARE}@${digest}`;
  const out: { ref: string; why?: string }[] = [];
  const refs = new Set(readWorkflow(text).images);
  // A caller may pass the bare name in as an input, so this file must not run it either.
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
    const vars = bareVariables([text, ...callerTexts]);
    const viaVar = (s: string) => vars.some((v) => refersTo(v).test(s));
    const podman = commandLines(text).some((l) => {
      // Any container tool, with any options before its run, pull or create.
      const m = /\b(?:podman|docker|nerdctl)\b.*?\b(?:run|pull|create)\b/.exec(l);
      // The whole command line counts, so an image piped or fed into the command is seen too.
      return !!m && (BARE_RE.test(l) || viaVar(l));
    });
    const declared = text.split(/\r?\n/).some((l) => {
      const m = /^\s*(?:-\s+)?(?:image|container|uses):\s*["']?(?:docker:\/\/)?(.*?)["']?\s*$/.exec(l);
      return !!m && (BARE_RE.test(m[1] as string) || viaVar(m[1] as string));
    });
    if (podman || declared) out.push({ ref, why: 'run without a digest' });
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
