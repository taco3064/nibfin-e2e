// Pure checks the Dashboard and site scenarios use. No network, no browser.

/** The Nibfin image Job containers run (Proposal R5.7); only image and event data are used, never product label keys. */
export const NIBFIN_IMAGE = 'ghcr.io/taco3064/nibfin';

/** Throws a failure naming the rule, what it expected and what it observed. */
export function fail(rule: string, expected: string, observed: string): never {
  throw new Error(`${rule}: expected ${expected}; observed ${observed}`);
}

export function check(ok: unknown, rule: string, expected: string, observed: string | (() => string)): void {
  if (!ok) fail(rule, expected, typeof observed === 'function' ? observed() : observed);
}

const PROOF = /([#&?]proof=)[^\s&#"']+/g;

/** Removes session proofs and the given secrets from text that may reach a reason or a log. */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text.replace(PROOF, '$1<redacted>');
  for (const s of secrets) if (s) out = out.split(s).join('<redacted>');
  return out;
}

export interface SessionUrl {
  sessionUrl: string;
  origin: string;
  port: number;
  proof: string;
}

/** Finds the Dashboard's session URL in its output; the proof must be only in the fragment (Proposal R9.26). */
export function parseSessionUrl(output: string): SessionUrl | undefined {
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/\S*/.exec(output);
  if (!m) return undefined;
  const url = new URL(m[0]);
  const proof = new URLSearchParams(url.hash.slice(1)).get('proof');
  if (!proof) return undefined;
  if (url.search.includes(proof) || url.pathname.includes(proof)) return undefined;
  return { sessionUrl: url.toString(), origin: url.origin, port: Number(m[1]), proof };
}

// ---- Local Job starts ----------------------------------------------------------

export interface ContainerStart {
  /** Milliseconds since the epoch. */
  at: number;
  name: string;
  image: string;
}

/** Parses `podman events --format json` lines into container starts of the Nibfin image. */
export function parseJobStarts(output: string): ContainerStart[] {
  const out: ContainerStart[] = [];
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const status = String(e.Status ?? e.status ?? '');
    const type = String(e.Type ?? e.type ?? 'container');
    const image = String(e.Image ?? e.image ?? '');
    if (status !== 'start' || type !== 'container' || !image.startsWith(NIBFIN_IMAGE)) continue;
    const nano = e.timeNano ?? e.TimeNano;
    const at =
      typeof nano === 'number' ? Math.floor(nano / 1e6) : typeof e.time === 'number' ? e.time * 1000 : Date.parse(String(e.Time ?? e.time ?? ''));
    out.push({ at: Number.isFinite(at) ? at : Date.now(), name: String(e.Name ?? e.name ?? ''), image });
  }
  return out;
}

export function startsInWindow(starts: ContainerStart[], from: number, to: number): ContainerStart[] {
  return starts.filter((s) => s.at >= from && s.at <= to);
}

// ---- Quiet sandboxes -----------------------------------------------------------

export const STAGE_LABELS = ['request', 'scope', 'shaped', 'delivered'] as const;
export const NIBFIN_LABELS = [...STAGE_LABELS, 'pause', 'pending'] as const;

export interface IssueState {
  number: number;
  title: string;
  labels: string[];
}

export interface QuietInput {
  /** Images of running containers (`podman ps`). */
  containers: { image: string; name: string }[];
  /** Open Issues per sandbox. */
  issues: { repo: string; issues: IssueState[] }[];
  /** Open pull requests of the execution sandbox. */
  pulls: number[];
  /** Queued or in-progress workflow runs of the execution sandbox. */
  runs: { id: number; name: string; status: string }[];
  /** Exact titles of this Issue's fixtures. */
  fixtures: string[];
}

/** What could start a local agent Job outside the fixtures; empty means quiet. */
export function quietProblems(input: QuietInput): string[] {
  const out: string[] = [];
  for (const c of input.containers) if (c.image.startsWith(NIBFIN_IMAGE)) out.push(`Nibfin container ${c.name} is running`);
  for (const { repo, issues } of input.issues) {
    for (const i of issues) {
      if (input.fixtures.includes(i.title)) continue;
      const staged = i.labels.includes('scope') || i.labels.includes('request');
      const held = i.labels.includes('pause') || i.labels.includes('pending');
      if (staged && !held) out.push(`${repo}#${i.number} is open with ${i.labels.filter((l) => l === 'scope' || l === 'request').join('+')} and neither pause nor pending`);
    }
  }
  for (const p of input.pulls) out.push(`pull request #${p} is open`);
  for (const r of input.runs) out.push(`workflow run ${r.id} (${r.name}) is ${r.status}`);
  return out;
}

// ---- Fixtures ------------------------------------------------------------------

export type FixtureKey = 'A' | 'B' | 'C' | 'D' | 'F' | 'N' | 'P' | 'E';

export interface FixtureSpec {
  key: FixtureKey;
  repo: 'execution' | 'peer';
  labels: string[];
  closed?: boolean;
  blockedBy: FixtureKey[];
}

export const fixtureTitle = (key: FixtureKey) => `[e2e #298] Dashboard fixture ${key}`;

/** The fixtures `ensureFixtures` creates; E is created only by `dashboard-updates`. */
export const FIXTURES: FixtureSpec[] = [
  { key: 'A', repo: 'execution', labels: ['scope', 'pause'], blockedBy: [] },
  { key: 'C', repo: 'execution', labels: ['delivered'], closed: true, blockedBy: [] },
  { key: 'P', repo: 'peer', labels: ['scope', 'pause'], blockedBy: [] },
  { key: 'B', repo: 'execution', labels: ['scope', 'shaped', 'pause'], blockedBy: ['A', 'C', 'P'] },
  { key: 'D', repo: 'execution', labels: ['scope', 'pending'], blockedBy: [] },
  { key: 'F', repo: 'execution', labels: ['scope', 'pause'], blockedBy: ['A'] },
  { key: 'N', repo: 'execution', labels: ['pause'], blockedBy: [] },
];

export const FIXTURE_E: FixtureSpec = { key: 'E', repo: 'execution', labels: ['scope'], blockedBy: [] };

export const ALL_FIXTURE_TITLES = [...FIXTURES, FIXTURE_E].map((f) => fixtureTitle(f.key));

/** Nibfin labels that differ from the spec; other labels are ignored. Empty means it matches. */
export function labelMismatch(spec: FixtureSpec, labels: string[]): string | undefined {
  const have = labels.filter((l) => (NIBFIN_LABELS as readonly string[]).includes(l)).sort();
  const want = [...spec.labels].sort();
  return have.join(',') === want.join(',') ? undefined : `has Nibfin labels [${have.join(', ')}], expected [${want.join(', ')}]`;
}

/** Stage of an open Issue by labels only (Proposal R9.2). */
export function stageOf(labels: string[]): 'Shape' | 'Deliver' | 'Done' | undefined {
  if (labels.includes('delivered')) return 'Done';
  if (labels.includes('scope') && labels.includes('shaped')) return 'Deliver';
  if (labels.includes('scope')) return 'Shape';
  return undefined;
}

// ---- Command schema -------------------------------------------------------------

export interface SchemaInput {
  name: string;
  required: boolean;
  values: string[];
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Reads the inputs with a non-empty `param` per command from a `/api/commands`
 * response. Tolerates a top-level array or an object holding one.
 */
export function commandInputs(json: unknown): Map<string, SchemaInput[]> {
  const list = Array.isArray(json)
    ? json
    : (Object.values((json ?? {}) as Record<string, unknown>).find((v) => Array.isArray(v)) as unknown[] | undefined) ?? [];
  const out = new Map<string, SchemaInput[]>();
  for (const raw of list) {
    const c = raw as Record<string, unknown>;
    const name = String(c.name ?? c.path ?? c.command ?? '').trim();
    if (!name) continue;
    const inputs: SchemaInput[] = [];
    for (const f of [...asArray(c.flags), ...asArray(c.args), ...asArray(c.arguments), ...asArray(c.positionals)]) {
      const i = f as Record<string, unknown>;
      if (typeof i.param !== 'string' || i.param === '') continue;
      const values = asArray(i.values ?? i.enum ?? i.choices ?? i.allowed).map(String);
      inputs.push({ name: String(i.name ?? i.param), required: i.required === true, values });
    }
    out.set(name.replace(/^gh\s+nibfin\s+/, ''), inputs);
  }
  return out;
}

export const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface FormField {
  role: string;
  name: string;
  required?: boolean;
  options?: string[];
}

/** Differences between a dialog's fields and the command's schema inputs (Proposal R9.13). */
export function fieldProblems(command: string, inputs: SchemaInput[], fields: FormField[]): string[] {
  const out: string[] = [];
  const matches = (input: SchemaInput, f: FormField) => {
    const a = normalizeName(input.name);
    const b = normalizeName(f.name);
    return a !== '' && b !== '' && (a === b || b.includes(a) || a.includes(b));
  };
  for (const input of inputs) {
    const f = fields.find((x) => matches(input, x));
    if (!f) {
      out.push(`${command}: no field for input ${input.name}`);
      continue;
    }
    if (input.required && f.required === false) out.push(`${command}: field ${f.name} is not marked required`);
    if (input.values.length && f.options) {
      const opts = f.options.map(normalizeName);
      for (const v of input.values) if (!opts.some((o) => o.includes(normalizeName(v)))) out.push(`${command}: field ${f.name} does not offer ${v}`);
    }
  }
  for (const f of fields) if (!inputs.some((i) => matches(i, f))) out.push(`${command}: field ${f.name} is not in the parameter schema`);
  return out;
}

const FIELD_ROLES = ['textbox', 'combobox', 'checkbox', 'spinbutton', 'switch', 'radiogroup', 'listbox', 'searchbox'];

/** Form fields from a Playwright aria snapshot (`- textbox "Repository"`). */
export function fieldsFromAriaSnapshot(snapshot: string): FormField[] {
  const out: FormField[] = [];
  for (const line of snapshot.split('\n')) {
    const m = /^\s*-\s+([a-z]+)\s+"([^"]*)"/.exec(line);
    if (!m || !FIELD_ROLES.includes(m[1] as string)) continue;
    out.push({ role: m[1] as string, name: m[2] as string });
  }
  return out;
}

// ---- Live data ------------------------------------------------------------------

export const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;
const HOST_KEY = /^(host|hostname|host_name|machine|machine_name|computer|computer_name|computername)$/i;

/** Walks every value of a JSON document. */
function walk(v: unknown, visit: (key: string, value: unknown, parentKey: string) => void, key = '', parentKey = ''): void {
  visit(key, v, parentKey);
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit, `${key}[]`, parentKey));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, visit, k, key);
}

/** Runner names and host names in one Live message (Proposal R9.11); messages are parsed JSON. */
export function liveLeaks(message: unknown, runnerNames: string[]): string[] {
  const out: string[] = [];
  const text = JSON.stringify(message);
  for (const n of runnerNames) if (n && text.includes(n)) out.push(`Runner name ${n} appears`);
  walk(message, (key, value, parentKey) => {
    const filled = typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined && typeof value !== 'object';
    if (HOST_KEY.test(key) && filled) out.push(`key ${key} has a value`);
    if (/^runners?(\[\])?$/i.test(parentKey) && /^(name|runner_name|runnerName)$/.test(key) && filled) out.push(`a runner entry has ${key}`);
  });
  return out;
}

export function messageKind(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  const k = o.type ?? o.event ?? o.kind;
  return typeof k === 'string' ? k : undefined;
}

/** Open Issue numbers per repository name in a snapshot: numbers of open entries in arrays under an `issues` key. */
export function snapshotOpenIssues(snapshot: unknown, repos: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const visitRepo = (repo: string, node: unknown) => {
    const nums = new Set<number>();
    walk(node, (key, value) => {
      if (!/^issues$/i.test(key) || !Array.isArray(value)) return;
      for (const i of value) {
        const o = i as Record<string, unknown>;
        if (typeof o?.number !== 'number') continue;
        const state = String(o.state ?? 'open').toLowerCase();
        if (state === 'open') nums.add(o.number);
      }
    });
    out.set(repo, [...nums].sort((a, b) => a - b));
  };
  walk(snapshot, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const o = value as Record<string, unknown>;
    const id = [o.repo, o.repository, o.name, o.full_name, o.nameWithOwner].find((x) => typeof x === 'string') as string | undefined;
    if (!id) return;
    const repo = repos.find((r) => id === r || id.endsWith(`/${r}`));
    if (repo && !out.has(repo)) visitRepo(repo, o);
  });
  if (out.size < repos.length && snapshot && typeof snapshot === 'object') {
    // Repositories keyed by name: { repos: { "nibfin-core": {…} } }
    walk(snapshot, (key, value) => {
      const repo = repos.find((r) => key === r || key.endsWith(`/${r}`));
      if (repo && !out.has(repo) && value && typeof value === 'object') visitRepo(repo, value);
    });
  }
  return out;
}

/** Repository names a snapshot covers. */
export function snapshotRepos(snapshot: unknown, candidates: RegExp = /^(?:[\w.-]+\/)?([\w.-]+)$/): string[] {
  const names = new Set<string>();
  walk(snapshot, (key, value) => {
    if (!/^repos$/i.test(key)) return;
    if (Array.isArray(value)) {
      for (const r of value) {
        const o = r as Record<string, unknown>;
        const id = [o?.repo, o?.repository, o?.full_name, o?.nameWithOwner, o?.name].find((x) => typeof x === 'string') as string | undefined;
        const m = id ? candidates.exec(id) : null;
        if (m?.[1]) names.add(m[1]);
      }
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        const m = candidates.exec(k);
        if (m?.[1]) names.add(m[1]);
      }
    }
  });
  return [...names].sort();
}

// ---- Deploy triggers ------------------------------------------------------------

/** Indentation-based read of a workflow's `on:` block: the triggers and push's branch filter. */
export function workflowTriggers(yaml: string): { events: string[]; pushBranches?: string[] } {
  const lines = yaml.replace(/\r/g, '').split('\n');
  const idx = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (idx < 0) return { events: [] };
  const inline = (lines[idx] as string).replace(/^["']?on["']?\s*:/, '').replace(/#.*$/, '').trim();
  const list = (s: string) =>
    s
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((x) => x.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  if (inline) return { events: list(inline) };
  const block: string[] = [];
  for (const l of lines.slice(idx + 1)) {
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    if (!/^\s/.test(l)) break;
    block.push(l);
  }
  const indent = (l: string) => (/^\s*/.exec(l)?.[0].length ?? 0);
  const top = Math.min(...block.map(indent));
  const events: string[] = [];
  let pushBranches: string[] | undefined;
  for (let i = 0; i < block.length; i++) {
    const l = block[i] as string;
    if (indent(l) === top) {
      const m = /^\s*-?\s*["']?([\w-]+)["']?\s*:?/.exec(l);
      if (m?.[1]) events.push(m[1]);
      if (m?.[1] !== 'push') continue;
      for (let j = i + 1; j < block.length && indent(block[j] as string) > top; j++) {
        const b = block[j] as string;
        const bm = /^\s*branches\s*:\s*(.*)$/.exec(b);
        if (!bm) continue;
        if ((bm[1] ?? '').trim()) pushBranches = list((bm[1] as string).replace(/#.*$/, '').trim());
        else {
          pushBranches = [];
          for (let k = j + 1; k < block.length && /^\s*-\s+/.test(block[k] as string); k++) {
            pushBranches.push((block[k] as string).replace(/^\s*-\s+/, '').replace(/#.*$/, '').trim().replace(/^["']|["']$/g, ''));
          }
        }
      }
    }
  }
  return { events, pushBranches };
}

/** Problems with a deploy workflow's triggers and runs on main (Proposal R9.48). */
export function deployProblems(file: string, yaml: string, runs: { event: string; head_branch: string; head_sha: string }[]): string[] {
  const out: string[] = [];
  const t = workflowTriggers(yaml);
  if (!t.events.includes('push')) out.push(`${file}: push is not among its triggers (${t.events.join(', ') || 'none'})`);
  else if (t.pushBranches && !t.pushBranches.includes('main')) out.push(`${file}: push is limited to branches ${t.pushBranches.join(', ')}, without main`);
  const onMain = runs.filter((r) => r.head_branch === 'main');
  if (!onMain.some((r) => r.event === 'push')) out.push(`${file}: no push run on main`);
  for (const sha of new Set(onMain.map((r) => r.head_sha))) {
    const events = onMain.filter((r) => r.head_sha === sha).map((r) => r.event);
    if (!events.includes('push')) out.push(`${file}: main commit ${sha.slice(0, 12)} has only ${[...new Set(events)].join(', ')} runs`);
  }
  return out;
}

// ---- Dates and times ------------------------------------------------------------

const MONTH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/;
const CLOCK = /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s*(AM|PM)?\b/i;

/** Date and time texts on a page: texts with a clock time or an English month. */
export function dateTexts(texts: string[]): string[] {
  return texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 80 && (CLOCK.test(t) || MONTH.test(t)));
}

/** Minutes after midnight of the first clock time in a text. */
export function clockMinutes(text: string): number | undefined {
  const m = CLOCK.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const ampm = m[4]?.toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}

/** Problems with date texts seen under two locales in one time zone (Proposal R9.7). */
export function localeProblems(a: string[], b: string[]): string[] {
  const out: string[] = [];
  if (!a.length) out.push('no date or time text on the page');
  if (a.join('\n') !== b.join('\n')) out.push(`texts differ between locales: [${a.slice(0, 5).join(' | ')}] vs [${b.slice(0, 5).join(' | ')}]`);
  for (const t of [...a, ...b]) if (/[^\u0020-\u024f\s·–—→]/.test(t)) out.push(`"${t}" is not in an English format`);
  return out;
}

/** True when some pair of times differs by `offsetMinutes` (mod 24 h). */
export function shiftedBy(a: string[], b: string[], offsetMinutes: number): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = clockMinutes(a[i] as string);
    const y = clockMinutes(b[i] as string);
    if (x === undefined || y === undefined) continue;
    if ((((y - x - offsetMinutes) % 1440) + 1440) % 1440 === 0) return true;
  }
  return false;
}

/** True when the shown clock times bracket the job within a minute (UTC times shown in UTC). */
export function intervalMatches(shown: string[], startedAt: string, completedAt: string, toleranceMs = 60_000): boolean {
  const minuteOf = (iso: string) => {
    const d = new Date(iso);
    return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  };
  const near = (shownMin: number, iso: string) => {
    const diff = Math.abs(shownMin - minuteOf(iso));
    return Math.min(diff, 1440 - diff) * 60_000 <= toleranceMs;
  };
  const mins = shown.flatMap((t) => [...t.matchAll(new RegExp(CLOCK.source, 'gi'))].map((m) => clockMinutes(m[0]) as number));
  return mins.some((s) => near(s, startedAt)) && mins.some((e) => near(e, completedAt));
}

/** Why fixture F cannot be the R9.20 target: F must be scope+pause without shaped and Blocked by the open, undelivered, paused A. */
export function pauseResumePreconditions(F: IssueState, A: IssueState & { id: number; state: string }, fBlockers: { id: number }[]): string[] {
  const out: string[] = [];
  if (!(F.labels.includes('scope') && F.labels.includes('pause') && !F.labels.includes('shaped'))) out.push(`F has [${F.labels.join(', ')}]`);
  if (!fBlockers.some((b) => b.id === A.id)) out.push('F is not Blocked by A');
  if (A.state !== 'open' || A.labels.includes('delivered') || !A.labels.includes('pause')) out.push(`A is ${A.state} with [${A.labels.join(', ')}]`);
  return out;
}
