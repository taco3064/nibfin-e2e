// Pure checks the Dashboard and site scenarios use. No network, no browser.
import type { Comment } from '../lifecycle/analysis.ts';
import { markerOf, time } from '../lifecycle/analysis.ts';
import { PENDING_MARKER } from '../lifecycle/marks.ts';
import { causeCodes } from '../lib/joblog.ts';
import { briefRecord, labelAddedAt, RESOLUTION_CLASSES, resolutionRecord } from '../lib/resolution.ts';
import type { ResolutionRecord } from '../lib/resolution.ts';

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
      typeof nano === 'number'
        ? Math.floor(nano / 1e6)
        : typeof e.time === 'number'
          ? e.time * 1000
          : Date.parse(String(e.Time ?? e.time ?? ''));
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
  for (const c of input.containers)
    if (c.image.startsWith(NIBFIN_IMAGE)) out.push(`Nibfin container ${c.name} is running`);
  for (const { repo, issues } of input.issues) {
    for (const i of issues) {
      if (input.fixtures.includes(i.title)) continue;
      const staged = i.labels.includes('scope') || i.labels.includes('request');
      const held = i.labels.includes('pause') || i.labels.includes('pending');
      if (staged && !held)
        out.push(
          `${repo}#${i.number} is open with ${i.labels.filter((l) => l === 'scope' || l === 'request').join('+')} and neither pause nor pending`,
        );
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
  return have.join(',') === want.join(',')
    ? undefined
    : `has Nibfin labels [${have.join(', ')}], expected [${want.join(', ')}]`;
}

/** Stage of an open Issue by labels only (Proposal R9.2). */
export function stageOf(labels: string[]): 'Shape' | 'Deliver' | 'Done' | undefined {
  if (labels.includes('delivered')) return 'Done';
  if (labels.includes('scope') && labels.includes('shaped')) return 'Deliver';
  if (labels.includes('scope')) return 'Shape';
  return undefined;
}

/** One repository's open Issues from GitHub and the open numbers its Live snapshot holds. */
export interface TrackRepo<T extends IssueState = IssueState> {
  repo: string;
  issues: T[];
  live: number[];
}

export interface TrackPick<T extends IssueState = IssueState> {
  repo: string;
  issue: T;
  stage: ReturnType<typeof stageOf>;
}

/**
 * The Issue whose stage track the Live page check reads (Proposal R9.2): open on GitHub
 * and in the snapshot; a label-given stage first, then `request`, then any other. Ties
 * go to the shown repository, then the given repository order, then the lowest number.
 */
export function pickTrackIssue<T extends IssueState>(repos: TrackRepo<T>[], shown?: string): TrackPick<T> | undefined {
  const rank = (labels: string[]) => (stageOf(labels) ? 0 : labels.includes('request') ? 1 : 2);
  const candidates = repos.flatMap((r, order) =>
    r.issues
      .filter((i) => r.live.includes(i.number))
      .map((issue) => ({
        repo: r.repo,
        issue,
        key: [rank(issue.labels), r.repo === shown ? 0 : 1, order, issue.number],
      })),
  );
  candidates.sort((a, b) => {
    for (let k = 0; k < a.key.length; k++)
      if (a.key[k] !== b.key[k]) return (a.key[k] as number) - (b.key[k] as number);
    return 0;
  });
  const best = candidates[0];
  return best && { repo: best.repo, issue: best.issue, stage: stageOf(best.issue.labels) };
}

/** The failure when no Live repository has an open Issue to check R9.2 on. */
export function noTrackIssueMessage(counts: { repo: string; open: number }[]): string {
  const names = counts.map((c) => c.repo);
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
      : (names[0] ?? 'any repository');
  return `R9.2: could not be checked: no open Issue in ${list} (open Issues: ${counts.map((c) => `${c.repo} ${c.open}`).join(', ')})`;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The accessible name of an Issue's own heading, `#<number> <title>` with its "(opens on GitHub …)"
 * note; not a blocker's `<repo>#<number> …`, another number, or a longer title.
 */
export function issueHeading(number: number, title: string): RegExp {
  const words = title.trim().split(/\s+/).map(reEscape).join('\\s+');
  return new RegExp(`^#${number}\\s+${words}(?:\\s+\\(opens\\b|\\s*$)`);
}

/** What is wrong with a stage track: its step texts and the current step against the label-given stage. */
export function trackProblem(
  steps: string[],
  current: string | undefined,
  want: string | undefined,
): string | undefined {
  const missing = ['Shape', 'Deliver', 'Done'].filter((s) => !steps.some((t) => new RegExp(`\\b${s}\\b`, 'i').test(t)));
  if (missing.length) return `no ${missing.join(', ')} step among [${steps.map((s) => s.trim()).join(' | ')}]`;
  if (want && !(current && new RegExp(`\\b${want}\\b`, 'i').test(current)))
    return `current step ${current === undefined ? 'none' : `"${current.trim()}"`}, labels give ${want}`;
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
    : ((Object.values((json ?? {}) as Record<string, unknown>).find((v) => Array.isArray(v)) as
        unknown[] | undefined) ?? []);
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

/** One HTTP response from the Dashboard API. */
export interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The session value from the proof exchange's response: a JSON field or a header. */
export function sessionFrom(reply: Reply): string | undefined {
  const header = reply.headers['x-nibfin-session'];
  if (typeof header === 'string' && header) return header;
  try {
    const j = JSON.parse(reply.body) as Record<string, unknown>;
    for (const [k, v] of Object.entries(j)) if (/session|token/i.test(k) && typeof v === 'string' && v) return v;
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * The command inputs from a `GET /api/commands` reply (Proposal R9.13, R5.23). Fails on a
 * status that is not 2xx, a body that is not JSON, or a response with no commands.
 */
export function commandSchemaFrom(reply: { status: number; body: string }): Map<string, SchemaInput[]> {
  const expected = 'GET /api/commands to return the command schema';
  if (reply.status < 200 || reply.status >= 300)
    fail('R9.13 (R5.23)', expected, `HTTP ${reply.status}: ${reply.body.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.body);
  } catch (error) {
    fail('R9.13 (R5.23)', expected, `a body that is not JSON (${(error as Error).message})`);
  }
  const schema = commandInputs(parsed);
  if (!schema.size) fail('R9.13 (R5.23)', expected, 'no commands in the response');
  return schema;
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
    if (!input.required && f.required === true)
      out.push(`${command}: field ${f.name} is marked required, the schema says optional`);
    if (input.values.length && !f.options)
      out.push(`${command}: field ${f.name} offers no choice of ${input.values.join(', ')}`);
    if (input.values.length && f.options) {
      const opts = f.options.map(normalizeName);
      for (const v of input.values)
        if (!opts.some((o) => o.includes(normalizeName(v))))
          out.push(`${command}: field ${f.name} does not offer ${v}`);
    }
  }
  for (const f of fields)
    if (!inputs.some((i) => matches(i, f))) out.push(`${command}: field ${f.name} is not in the parameter schema`);
  return out;
}

const FIELD_ROLES = ['textbox', 'combobox', 'checkbox', 'spinbutton', 'switch', 'radiogroup', 'listbox', 'searchbox'];

/**
 * Form fields from a Playwright aria snapshot (`- textbox "Repository"`), with the
 * `option` and `radio` lines nested under a field as its options. The required flag
 * is not in a snapshot; the caller reads it from the element.
 */
export function fieldsFromAriaSnapshot(snapshot: string): FormField[] {
  const out: FormField[] = [];
  let current: { field: FormField; indent: number } | undefined;
  for (const line of snapshot.split('\n')) {
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    const m = /^\s*-\s+([a-z]+)(?:\s+"([^"]*)")?/.exec(line);
    if (!m) continue;
    const role = m[1] as string;
    if (current && indent > current.indent && (role === 'option' || role === 'radio') && m[2] !== undefined) {
      (current.field.options ??= []).push(m[2]);
      continue;
    }
    if (current && indent <= current.indent) current = undefined;
    if (!FIELD_ROLES.includes(role) || m[2] === undefined) continue;
    const field: FormField = { role, name: m[2] };
    out.push(field);
    current = { field, indent };
  }
  return out;
}

// ---- Buttons --------------------------------------------------------------------

/**
 * The accessible names of the `button` lines in a `Locator.ariaSnapshot()`, in order.
 * Trailing `[attr]` parts are ignored; a button line without a name reads `(unnamed)`.
 */
export function buttonNamesFromAriaSnapshot(snapshot: string): string[] {
  const out: string[] = [];
  for (const line of snapshot.split('\n')) {
    const m = /^\s*-\s+([a-z]+)(?:\s+"([^"]*)")?/.exec(line);
    if (m?.[1] === 'button') out.push(m[2] ?? '(unnamed)');
  }
  return out;
}

const SHOWN_MAX = 15;
const SHOWN_NAME_MAX = 40;

/**
 * The failure when no button matching `name` appears in `where`: the fixed
 * `<rule>: expected a <name> button in <where>; observed none` prefix, then the buttons
 * shown (whitespace-collapsed, each trimmed to 40 characters, at most 15), "no buttons
 * shown" for an empty list, or "the buttons shown could not be read" when `shown` is undefined.
 */
export function missingButtonMessage(rule: string, name: RegExp, where: string, shown: string[] | undefined): string {
  return `${rule}: expected a ${name} button in ${where}; observed none; ${shownButtons(shown)}`;
}

/** Names quoted for a reason: whitespace-collapsed, each trimmed to 40 characters, at most 15, then "… and N more". */
function quotedNames(names: string[]): string {
  const trim = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > SHOWN_NAME_MAX ? `${t.slice(0, SHOWN_NAME_MAX - 1)}…` : t;
  };
  const listed = names
    .slice(0, SHOWN_MAX)
    .map((s) => `"${trim(s)}"`)
    .join(', ');
  const more = names.length > SHOWN_MAX ? ` … and ${names.length - SHOWN_MAX} more` : '';
  return `${listed}${more}`;
}

/** The buttons a scope showed, as a missing-button reason states them. */
function shownButtons(shown: string[] | undefined): string {
  if (shown === undefined) return 'the buttons shown could not be read';
  if (!shown.length) return 'no buttons shown';
  return `buttons shown: ${quotedNames(shown)}`;
}

// ---- Login relay ----------------------------------------------------------------

/**
 * The control that starts or continues a Dashboard login (Proposal R6.16). Anchored at
 * the start of the name and ending on a word boundary, so "Close", "Cancel",
 * "Cancel login" and "Restart" never match.
 */
export const LOGIN_START = /^(start|log ?in|continue|next|preview|confirm)\b/i;

/** Dialog text that reports an existing login; it needs the word "already", so "not logged in" does not match. */
export const ALREADY_LOGGED_IN = /\balready\s+(logged|signed)\s+in\b|\balready\s+authenticated\b/i;

/** What the login dialog's provider step did: set to claude, no provider field, or the error setting it raised. */
export type ProviderStep = { kind: 'set' } | { kind: 'absent' } | { kind: 'failed'; error: string };

/**
 * What the login dialog's start step did: the control it clicked, no click because the
 * dialog already showed a URL or a code field, or no start control within the wait
 * together with the buttons shown (undefined when they could not be read).
 */
export type StartStep =
  | { kind: 'clicked'; name: string }
  | { kind: 'not-needed'; why: 'url' | 'code field' }
  | { kind: 'none'; waitedMs: number; shown: string[] | undefined };

const LOGGED_IN_LINE_MAX = 120;
const DIALOG_TEXT_TAIL = 300;

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * The observed part of the R6.16 failure when the login dialog relayed no https URL:
 * how long it waited, the provider and start steps' outcomes, the line reporting an
 * existing login if the text has one, the dialog's buttons and fields (undefined when
 * they could not be read) and the end of its text. It does not redact; the scenario's
 * failure handling redacts every reason.
 */
export function noRelayedUrlObserved(o: {
  provider: ProviderStep;
  start: StartStep;
  waitedMs: number;
  buttons: string[] | undefined;
  fields: FormField[] | undefined;
  text: string;
}): string {
  const parts = [`no https URL after ${seconds(o.waitedMs)}`];
  const p = o.provider;
  parts.push(
    `provider: ${p.kind === 'set' ? 'set to claude' : p.kind === 'absent' ? 'no provider field' : `could not be set: ${p.error}`}`,
  );
  const s = o.start;
  parts.push(
    `start: ${
      s.kind === 'clicked'
        ? `clicked "${s.name}"`
        : s.kind === 'not-needed'
          ? `not needed (the dialog showed ${s.why === 'url' ? 'a URL' : 'a code field'})`
          : `no ${LOGIN_START} control appeared within ${seconds(s.waitedMs)}; ${shownButtons(s.shown)}`
    }`,
  );
  const line = o.text.split('\n').find((l) => ALREADY_LOGGED_IN.test(l));
  if (line !== undefined) {
    const t = line.replace(/\s+/g, ' ').trim();
    const quoted = t.length > LOGGED_IN_LINE_MAX ? `${t.slice(0, LOGGED_IN_LINE_MAX - 1)}…` : t;
    parts.push(`the dialog reports an existing login: "${quoted}"`);
  }
  const listed = <T>(xs: T[] | undefined, show: (x: T[]) => string) =>
    xs === undefined ? 'could not be read' : xs.length ? show(xs) : 'none';
  parts.push(`dialog buttons: ${listed(o.buttons, quotedNames)}`);
  parts.push(`dialog fields: ${listed(o.fields, (fs) => fs.map((f) => `${f.role} "${f.name}"`).join(', '))}`);
  parts.push(`dialog text ends: "${o.text.replace(/\s+/g, ' ').trim().slice(-DIALOG_TEXT_TAIL)}"`);
  return parts.join('; ');
}

// ---- Live data ------------------------------------------------------------------

export const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;
const HOST_KEY = /^(host|hostname|host_name|machine|machine_name|computer|computer_name|computername)$/i;

/** Walks every value of a JSON document. */
function walk(
  v: unknown,
  visit: (key: string, value: unknown, parentKey: string) => void,
  key = '',
  parentKey = '',
): void {
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
    const filled =
      typeof value === 'string'
        ? value.trim() !== ''
        : value !== null && value !== undefined && typeof value !== 'object';
    if (HOST_KEY.test(key) && filled) out.push(`key ${key} has a value`);
    if (/^runners?(\[\])?$/i.test(parentKey) && /^(name|runner_name|runnerName)$/.test(key) && filled)
      out.push(`a runner entry has ${key}`);
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
    out.set(
      repo,
      [...nums].sort((a, b) => a - b),
    );
  };
  walk(snapshot, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const o = value as Record<string, unknown>;
    const id = [o.repo, o.repository, o.name, o.full_name, o.nameWithOwner].find((x) => typeof x === 'string') as
      string | undefined;
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

/**
 * Repository names a snapshot covers: the last path segment of each `repos` entry id or `repos` object key,
 * for ids of the form `REPO`, `OWNER/REPO` or `HOST/OWNER/REPO`. Empty ids, ids with whitespace and ids
 * ending in `/` are ignored.
 */
export function snapshotRepos(snapshot: unknown, candidates: RegExp = /^(?:[\w.-]+\/)*([\w.-]+)$/): string[] {
  const names = new Set<string>();
  walk(snapshot, (key, value) => {
    if (!/^repos$/i.test(key)) return;
    if (Array.isArray(value)) {
      for (const r of value) {
        const o = r as Record<string, unknown>;
        const id = [o?.repo, o?.repository, o?.full_name, o?.nameWithOwner, o?.name].find(
          (x) => typeof x === 'string',
        ) as string | undefined;
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
  const inline = (lines[idx] as string)
    .replace(/^["']?on["']?\s*:/, '')
    .replace(/#.*$/, '')
    .trim();
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
  const indent = (l: string) => /^\s*/.exec(l)?.[0].length ?? 0;
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
            pushBranches.push(
              (block[k] as string)
                .replace(/^\s*-\s+/, '')
                .replace(/#.*$/, '')
                .trim()
                .replace(/^["']|["']$/g, ''),
            );
          }
        }
      }
    }
  }
  return { events, pushBranches };
}

/** Problems with a deploy workflow's triggers and runs on main (Proposal R9.48). */
export function deployProblems(
  file: string,
  yaml: string,
  runs: { event: string; head_branch: string; head_sha: string }[],
): string[] {
  const out: string[] = [];
  const t = workflowTriggers(yaml);
  if (!t.events.includes('push'))
    out.push(`${file}: push is not among its triggers (${t.events.join(', ') || 'none'})`);
  else if (t.pushBranches && !t.pushBranches.includes('main'))
    out.push(`${file}: push is limited to branches ${t.pushBranches.join(', ')}, without main`);
  const onMain = runs.filter((r) => r.head_branch === 'main');
  if (!onMain.some((r) => r.event === 'push')) out.push(`${file}: no push run on main`);
  for (const sha of new Set(onMain.map((r) => r.head_sha))) {
    const events = onMain.filter((r) => r.head_sha === sha).map((r) => r.event);
    if (!events.includes('push'))
      out.push(`${file}: main commit ${sha.slice(0, 12)} has only ${[...new Set(events)].join(', ')} runs`);
  }
  return out;
}

// ---- Dates and times ------------------------------------------------------------

const MONTH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/;
const CLOCK = /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s*(AM|PM)?\b/i;

/** Date and time texts on a page: texts with a clock time or an English month. */
export function dateTexts(texts: string[]): string[] {
  return texts
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length < 80 && (CLOCK.test(t) || MONTH.test(t)));
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
  if (a.join('\n') !== b.join('\n'))
    out.push(`texts differ between locales: [${a.slice(0, 5).join(' | ')}] vs [${b.slice(0, 5).join(' | ')}]`);
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
export function intervalMatches(
  shown: string[],
  startedAt: string,
  completedAt: string,
  toleranceMs = 60_000,
): boolean {
  const minuteOf = (iso: string) => {
    const d = new Date(iso);
    return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  };
  const near = (shownMin: number, iso: string) => {
    const diff = Math.abs(shownMin - minuteOf(iso));
    return Math.min(diff, 1440 - diff) * 60_000 <= toleranceMs;
  };
  const mins = shown.flatMap((t) =>
    [...t.matchAll(new RegExp(CLOCK.source, 'gi'))].map((m) => clockMinutes(m[0]) as number),
  );
  return mins.some((s) => near(s, startedAt)) && mins.some((e) => near(e, completedAt));
}

/** Why fixture F cannot be the R9.20 target: F must be scope+pause without shaped and Blocked by the open, undelivered, paused A. */
export function pauseResumePreconditions(
  F: IssueState,
  A: IssueState & { id: number; state: string },
  fBlockers: { id: number }[],
): string[] {
  const out: string[] = [];
  if (!(F.labels.includes('scope') && F.labels.includes('pause') && !F.labels.includes('shaped')))
    out.push(`F has [${F.labels.join(', ')}]`);
  if (!fBlockers.some((b) => b.id === A.id)) out.push('F is not Blocked by A');
  if (A.state !== 'open' || A.labels.includes('delivered') || !A.labels.includes('pause'))
    out.push(`A is ${A.state} with [${A.labels.join(', ')}]`);
  return out;
}

/** What an Issue element showed about pause: whether it is rendered, its text and its Pause/Resume controls. */
export interface PauseView {
  present: boolean;
  text: string;
  pauseControls: number;
  resumeControls: number;
}

const PAUSE_MARKER = /\bpaused?\b/gi;

/**
 * How many pause markers (R9.2) an Issue element shows, not counting Pause control labels. The
 * element text includes its button labels, so each Pause control adds one "Pause" word that is
 * not a marker; a "Resume" label never matches.
 */
export function pauseMarkers(v: PauseView): number {
  return Math.max(0, (v.text.match(PAUSE_MARKER)?.length ?? 0) - v.pauseControls);
}

/**
 * Why an Issue element is not ready for a pause to be added and detected, or undefined when it
 * is: it must be listed, offer a Pause or Resume control (R9.19) and show no pause marker yet.
 * A `pending` Issue may offer only Resume (R9.55, R5.51), which is accepted.
 */
export function pausePreconditionProblem(v: PauseView): string | undefined {
  if (!v.present || !v.text.trim()) return 'not listed';
  if (v.pauseControls + v.resumeControls === 0) return 'no Pause or Resume control';
  if (pauseMarkers(v) > 0) return 'already shows a pause marker';
  return undefined;
}

/**
 * Whether an Issue element shows a pause that was not there before (R9.2, R9.19, R5.51): a new
 * Resume control or more pause markers than before. A Resume control the element already had
 * before does not count, and Pause control labels are not markers. A missing or empty element,
 * a Pause control that only disappeared, or other new label names never count.
 */
export function pauseAppeared(before: PauseView, after: PauseView): boolean {
  if (!after.present || !after.text.trim()) return false;
  if (after.resumeControls > before.resumeControls) return true;
  return pauseMarkers(after) > pauseMarkers(before);
}

/** A short, one-line description of a PauseView for a failure message. */
export function describePauseView(v: PauseView): string {
  if (!v.present) return 'not listed';
  const t = v.text.replace(/\s+/g, ' ').trim();
  return `${v.pauseControls} Pause and ${v.resumeControls} Resume control(s), text "${t.length > 200 ? `${t.slice(0, 200)}…` : t}"`;
}

/** How long a manual view may take to show a pause after each manual refresh (R9.8), and how often it is read. */
export const MANUAL_PAUSE_WAIT_MS = 60_000;
export const MANUAL_PAUSE_POLL_MS = 2_000;
/** Manual refreshes allowed: the first one and one retry with the same method. */
export const MANUAL_PAUSE_REFRESHES = 2;

/** One manual refresh: how it was done and when, in ms after the edit. */
export interface ManualRefresh {
  method: 'Refresh control' | 'fresh view';
  atMs: number;
}

export interface ManualPauseOutcome {
  seen: boolean;
  refreshes: ManualRefresh[];
  /** What the last read showed. */
  last: PauseView;
  /** From the first refresh to the last read. */
  waitedMs: number;
}

/**
 * Refreshes a manual view and reads the Issue element until it shows a pause that was not
 * there `before` (`pauseAppeared`) or `boundMs` passed since that refresh; then refreshes
 * once more, up to `attempts` refreshes in all. Each refresh's read is made at least once.
 * The clock and sleep are injected so the sequence can be tested without real waiting.
 */
export async function pauseAfterManualRefresh(o: {
  before: PauseView;
  refresh: () => Promise<ManualRefresh['method']>;
  read: () => Promise<PauseView>;
  since: number;
  boundMs: number;
  everyMs: number;
  attempts: number;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}): Promise<ManualPauseOutcome> {
  const refreshes: ManualRefresh[] = [];
  let last: PauseView = { present: false, text: '', pauseControls: 0, resumeControls: 0 };
  let first: number | undefined;
  let lastRead = o.now();
  for (let i = 0; i < Math.max(1, o.attempts); i++) {
    const method = await o.refresh();
    const at = o.now();
    first ??= at;
    refreshes.push({ method, atMs: at - o.since });
    for (;;) {
      last = await o.read();
      lastRead = o.now();
      if (pauseAppeared(o.before, last)) return { seen: true, refreshes, last, waitedMs: lastRead - first };
      if (lastRead - at >= o.boundMs) break;
      await o.sleep(o.everyMs);
    }
  }
  return { seen: false, refreshes, last, waitedMs: lastRead - (first ?? lastRead) };
}

/** The observed text of an R9.8 failure when a manual view never showed the pause after its refreshes. */
export function manualPauseMissed(o: {
  outcome: ManualPauseOutcome;
  before: PauseView;
  boundMs: number;
  marker: string;
  header: string;
}): string {
  const { refreshes, waitedMs, last } = o.outcome;
  const how = refreshes.map((r) => `${r.method} at +${seconds(r.atMs)}`).join(', ');
  const h = o.header.replace(/\s+/g, ' ').trim();
  const header = h ? `"${h.length > 200 ? `${h.slice(0, 200)}…` : h}"` : '(none)';
  return (
    `not shown after ${refreshes.length} refresh(es): ${how} after the edit; ` +
    `waited ${seconds(waitedMs)} in total (bound ${seconds(o.boundMs)} after each refresh); ` +
    `update marker after the last read: ${o.marker}; header: ${header}; ` +
    `before the edit: ${describePauseView(o.before)}; after the last read: ${describePauseView(last)}`
  );
}

/** The first primitive value in a JSON document under a key matching `key`. */
export function statusValue(json: unknown, key: RegExp): string | number | boolean | undefined {
  let found: string | number | boolean | undefined;
  walk(json, (k, v) => {
    if (found !== undefined || !key.test(k.replace(/\[\]$/, ''))) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') found = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const inner = o.ok ?? o.state ?? o.status ?? o.healthy;
      if (typeof inner === 'string' || typeof inner === 'boolean') found = inner;
    }
  });
  return found;
}

const GOOD =
  /^(ok|true|yes|running|healthy|success|succeeded|passed|active|up[ _-]?to[ _-]?date|current|latest|green|good)$/i;
const BAD =
  /^(false|no|fail(ed|ure)?|error|missing|stale|outdated|inactive|broken|never|red|bad|none|not[ _-].*|upgrade[ _-]available)$/i;

/** `good`, `bad` or undefined for a status value. */
export function stateOf(v: string | number | boolean | undefined): 'good' | 'bad' | undefined {
  if (typeof v === 'boolean') return v ? 'good' : 'bad';
  if (typeof v !== 'string') return undefined;
  return GOOD.test(v.trim()) ? 'good' : BAD.test(v.trim()) ? 'bad' : undefined;
}

const LIGHT_GOOD =
  /\b(ok|running|healthy|success|succeeded|pass(ed|ing)?|active|up to date|current|latest|good|working)\b/i;
const LIGHT_BAD =
  /\b(fail(ed|ing|ure)?|error|missing|not|stale|outdated|inactive|broken|never|warning|upgrade|unknown)\b/i;

/** Problem when a light's text or label does not say the state the status reports (Proposal R9.4). */
export function lightProblem(name: string, lightText: string, state: 'good' | 'bad' | undefined): string | undefined {
  if (!state) return `${name}: status --json gives no readable state`;
  const good = LIGHT_GOOD.test(lightText) && !LIGHT_BAD.test(lightText);
  const bad = LIGHT_BAD.test(lightText);
  if (state === 'good' && !good) return `${name}: status is good but the light says "${lightText.slice(0, 80)}"`;
  if (state === 'bad' && !bad) return `${name}: status is not good but the light says "${lightText.slice(0, 80)}"`;
  return undefined;
}

/** How a view header marks its updates (Proposal R9.8). */
export type UpdateMarker = 'live' | 'manual' | 'neither' | 'both';

/** An element that says the view updates automatically: exactly `Live`. */
export const LIVE_MARKER = /^live$/i;
/** The Dashboard's manual and live-off wording, matched exactly. */
export const MANUAL_MARKER = /^(updates on refresh|live updates off)$/i;
/** Earlier manual wording, matched anywhere in an element's text. */
export const MANUAL_WORDING = /manual|refresh manually|not live|paused updates/i;

/**
 * Sorts a header's markers (Proposal R9.8). Each item is the visible text of one element;
 * control text such as `Refresh`, tab names or freshness text is neither marker.
 */
export function classifyUpdateMarker(texts: string[]): UpdateMarker {
  let live = false;
  let manual = false;
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (LIVE_MARKER.test(t)) live = true;
    else if (MANUAL_MARKER.test(t) || MANUAL_WORDING.test(t)) manual = true;
  }
  return live ? (manual ? 'both' : 'live') : manual ? 'manual' : 'neither';
}

/** Page wording for a view whose first read has not finished, matched anywhere (Proposal R9.34). */
export const NO_DATA_YET = /\bno data yet\b/i;
/** Header wording while a read is in progress, matched against one element's whole text. */
export const REFRESHING = /^refreshing(…|\.\.\.)?$/i;

/**
 * A view's update marker (Proposal R9.8), or `loading` while the view visibly has not
 * finished its first read: no marker, and the page says "No data yet" or a header element
 * says only "Refreshing…". A view that shows a marker is never `loading`.
 */
export function updateMarkerState(headerTexts: string[], pageText: string): UpdateMarker | 'loading' {
  const kind = classifyUpdateMarker(headerTexts);
  if (kind !== 'neither') return kind;
  const refreshing = headerTexts.some((t) => REFRESHING.test(t.replace(/\s+/g, ' ').trim()));
  return refreshing || NO_DATA_YET.test(pageText) ? 'loading' : kind;
}

// ---- Summary tile counts (Proposal R9.1) ----------------------------------------

/**
 * Standalone counts: digit runs that are not part of a longer word, a login, an Issue
 * reference (`#12`, `repo#12`), a path or a decimal (`3.1`).
 */
const COUNT = /(?<![\p{L}\d_#./-])\d+(?![\p{L}\d_]|\.\d)/gu;
/** Most non-digit characters between a word and its count. */
const COUNT_GAP = 16;

/** True when the text shows at least one standalone count. */
export function hasCount(text: string): boolean {
  return new RegExp(COUNT.source, COUNT.flags).test(text);
}

/**
 * The standalone count nearest a whole word in a tile's text: "Open Issues 14", "14 open",
 * "Shape 3 Deliver 2" (3 for Shape, 2 for Deliver). Candidates are the nearest count after
 * and before an occurrence of the word, within 16 non-digit characters; the shorter gap
 * wins, the count after on a tie. The first occurrence with a candidate decides.
 */
export function countNear(text: string, word: RegExp): number | undefined {
  const t = text.replace(/\s+/g, ' ');
  const counts = [...t.matchAll(new RegExp(COUNT.source, COUNT.flags))].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    n: Number(m[0]),
  }));
  const gapOk = (gap: string) => gap.length <= COUNT_GAP && !/\d/.test(gap);
  for (const w of t.matchAll(new RegExp(`\\b(?:${word.source})\\b`, 'gi'))) {
    if (!w[0]) continue;
    const ws = w.index;
    const we = ws + w[0].length;
    const after = counts.find((c) => c.start >= we);
    const before = counts.findLast((c) => c.end <= ws);
    const a = after && gapOk(t.slice(we, after.start)) ? { n: after.n, gap: after.start - we } : undefined;
    const b = before && gapOk(t.slice(before.end, ws)) ? { n: before.n, gap: ws - before.end } : undefined;
    if (a && (!b || a.gap <= b.gap)) return a.n;
    if (b) return b.n;
  }
  return undefined;
}

// ---- Pending resolution states (Proposal R9.52–R9.56, R9.1) ----------------------

/** The Dashboard's three states of an Issue with `pending` (R9.52): 自動排除中, 等你選擇, 需要你處理. */
export type ResolutionState = 'auto' | 'choose' | 'handle';

/**
 * The state a resolution record gives (R4.49, R9.52): no record yet is 自動排除中, options
 * are 等你選擇, next steps are 需要你處理, and a record with neither gives no state.
 */
export function stateOfRecord(r: ResolutionRecord | undefined): ResolutionState | undefined {
  if (!r) return 'auto';
  if (r.options.length > 0) return 'choose';
  if (r.nextSteps) return 'handle';
  return undefined;
}

/** Terms that each name exactly one state. No rule fixes the wording, so they are loose. */
export const STATE_TERMS: Record<ResolutionState, RegExp> = {
  auto: /自動排除中|\brepairing\b|\bauto[\s-]?repair\w*|\bresolving automatically\b|\bauto[\s-]?resolv\w*/i,
  choose: /等你選擇|\bchoose\b|\byour choice\b|\bwaiting for your decision\b/i,
  handle: /需要你處理|\bneeds your action\b|\baction needed\b|\bact\b/i,
};

/** The single state an element's text names, or undefined when it names none or more than one. */
export function shownState(text: string): ResolutionState | undefined {
  const named = (Object.keys(STATE_TERMS) as ResolutionState[]).filter((s) => STATE_TERMS[s].test(text));
  return named.length === 1 ? named[0] : undefined;
}

export interface LabelEvent {
  event: string;
  created_at: string;
  label?: { name: string };
}

/** The time of the most recent `labeled pending` event while the Issue has `pending`, else undefined. */
export function latestPending(labels: string[], events: LabelEvent[]): number | undefined {
  return labels.includes('pending') ? labelAddedAt(events, 'pending') : undefined;
}

/** How far before the label Nibfin may write its pending comment (nibfin-core#777 writes the comment first). */
export const PENDING_SKEW_MS = 60_000;
/** How far behind GitHub the Dashboard may be: R9.24 polls at most every 60 s, plus a margin. */
export const LAG_MS = 90_000;

const lastWrite = (c: Comment) => Math.max(time(c.created_at), time(c.updated_at));

/**
 * Whether the Issue's latest `pending` is Nibfin's: a `pending` comment written or updated
 * no earlier than `PENDING_SKEW_MS` before the most recent `labeled pending` event. A
 * harness-added `pending` (fixture D) has no such comment.
 */
export function nibfinPending(labels: string[], events: LabelEvent[], comments: Comment[]): boolean {
  const at = latestPending(labels, events);
  if (at === undefined) return false;
  return comments.some((c) => PENDING_MARKER.test(markerOf(c.body) ?? '') && lastWrite(c) >= at - PENDING_SKEW_MS);
}

/**
 * Why an Issue may not show 自動排除中 when read at `readAt`, or undefined when it may: it
 * has `pause`, its latest `pending` is not Nibfin's, or a record written after that
 * `pending` is older than the Dashboard's lag. Records from before it are ignored.
 */
export function autoProblem(
  issue: { labels: string[] },
  events: LabelEvent[],
  comments: Comment[],
  readAt: number,
): string | undefined {
  if (issue.labels.includes('pause')) return 'it has pause';
  const at = latestPending(issue.labels, events);
  if (at === undefined) return `it has no pending label with a labeled event (labels [${issue.labels.join(', ')}])`;
  const since = new Date(at).toISOString();
  if (!nibfinPending(issue.labels, events, comments))
    return `no Nibfin pending comment was written for its pending added at ${since}`;
  const r = resolutionRecord(comments, at);
  if (r && r.at <= readAt - LAG_MS)
    return `its resolution record ${r.url} (written ${new Date(r.at).toISOString()}) is more than ${LAG_MS / 1000} s older than the read at ${new Date(readAt).toISOString()}`;
  return undefined;
}

/** Whether an Issue may show 自動排除中 when read at `readAt` (see `autoProblem`). */
export function autoEligible(
  issue: { labels: string[] },
  events: LabelEvent[],
  comments: Comment[],
  readAt: number,
): boolean {
  return autoProblem(issue, events, comments, readAt) === undefined;
}

/** R9.1's expected needs-intervention Issues: the held ones minus those shown as 自動排除中 and eligible (R9.52). */
export function needsExpected<T extends { html_url: string }>(held: T[], autoShownEligible: T[]): T[] {
  const out = new Set(autoShownEligible.map((i) => i.html_url));
  return held.filter((i) => !out.has(i.html_url));
}

/** Text for loose comparison: no markdown emphasis or code marks, whitespace collapsed, lower case. */
export const normalText = (t: string) => t.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Whether `text` shows `cause`: its first 20 characters (the Dashboard may shorten the rest). */
export function causeShown(text: string, cause: string): boolean {
  const c = normalText(cause);
  if (!c) return false;
  return normalText(text).includes(c.slice(0, Math.min(20, c.length)));
}

/** The loose next-steps heading list of `scenarios/lib/resolution.ts`. */
const NEXT_STEPS_HEADING = /後續建議|下一步|建議步驟|後續步驟|next[\s-]*steps?|follow[\s-]*up|advice/i;
const plainLine = (line: string) =>
  line
    .replace(/^[\s>#*_-]+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\d+\s*[.)、:：]\s*/, '')
    .trim();

/** Whether a line is a heading, and its text: a markdown heading, a wholly bold line, or a label ending in a colon. */
function headingText(line: string): string | undefined {
  const t = line.trim();
  if (/^#{1,6}\s/.test(t) || /^\*\*[^*]+\*\*[:：]?$/.test(t))
    return plainLine(t)
      .replace(/[:：]$/, '')
      .trim();
  const m = /^([^:：]{1,30}?)\s*[:：]\s*$/.exec(plainLine(t));
  return m ? (m[1] ?? '').trim() : undefined;
}

/** The plain lines under a record's next-steps heading (R4.46), numbering and list marks removed. */
export function nextStepLines(body: string): string[] {
  const out: string[] = [];
  let inNext = false;
  for (const line of body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*(```|~~~)/.test(line)) continue;
    const h = headingText(line);
    if (h !== undefined) {
      inNext = NEXT_STEPS_HEADING.test(h);
      continue;
    }
    const field = /^([^:：]{1,30}?)\s*[:：]\s*(.+)$/.exec(plainLine(line));
    if (!inNext && field && NEXT_STEPS_HEADING.test(field[1] ?? '')) {
      out.push((field[2] ?? '').trim());
      continue;
    }
    if (inNext) {
      const t = plainLine(line);
      if (t) out.push(t);
    }
  }
  return out;
}

/** An option's text without its recommendation mark, for matching what the dialog shows. */
export const optionLabel = (text: string) =>
  text
    .replace(/[（(【[]\s*(建議|推薦|recommended|recommendation)\s*[)）】\]]/gi, '')
    .replace(/\s*[-—–:：]?\s*(建議|推薦|recommended)\s*$/i, '')
    .trim();

/**
 * The option number a dialog choice names: a leading number ("2", "Option 2", "選項 2"),
 * else the option whose label's first 20 characters the choice shows; undefined otherwise.
 */
export function optionOfChoice(name: string, options: { n: number; text: string }[]): number | undefined {
  const lead = /^\s*(?:option|選項)?\s*(\d+)\b/i.exec(name);
  if (lead && options.some((o) => o.n === Number(lead[1]))) return Number(lead[1]);
  return options.find((o) => causeShown(name, optionLabel(o.text)))?.n;
}

/** The option number a decision comment names: `option=N` in its marker, else a text that is only a number. */
export function decisionOption(body: string): number | undefined {
  const marked = /<!--\s*nibfin:[^>]*\boption\s*[=:]\s*(\d+)/i.exec(body);
  if (marked) return Number(marked[1]);
  const text = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  const only = /^(?:option|選項)?\s*(\d+)$/i.exec(text);
  return only ? Number(only[1]) : undefined;
}

// ---- The 等你選擇 dialog (Proposal R9.54, R4.51) -----------------------------------

/**
 * The name of a dialog choice that lets the person reply in their own words instead of
 * picking an option (R4.51). No rule fixes the wording, so it is loose.
 */
export const OWN_WORDS =
  /自己的話|自行輸入|自訂|其他|\bown words\b|\bin your (own )?words\b|\bother\b|\bcustom\b|free[- ]?text|\bwrite (a|your own) (reply|answer)\b/i;

const CONTROL_ROLES = ['button', 'textbox', 'searchbox', 'radio', 'option', 'checkbox', 'combobox', 'switch'];

/**
 * Every control line of a `Locator.ariaSnapshot()`, in order, as `role "name"`, or
 * `role (unnamed)` when the control has no name. Failure messages name a dialog's controls with it.
 */
export function controlsFromAriaSnapshot(snapshot: string): string[] {
  const out: string[] = [];
  for (const line of snapshot.split('\n')) {
    const m = /^\s*-\s+([a-z]+)(?:\s+"([^"]*)")?/.exec(line);
    if (!m || !CONTROL_ROLES.includes(m[1] as string)) continue;
    out.push(m[2] === undefined ? `${m[1]} (unnamed)` : `${m[1]} "${m[2]}"`);
  }
  return out;
}

/** The index of the single choice that is the own-words entry (named as `OWN_WORDS`, matching no option), else undefined. */
export function ownWordsIndex(choices: { name: string }[], r: Pick<ResolutionRecord, 'options'>): number | undefined {
  const found = choices
    .map((ch, i) => ({ ch, i }))
    .filter(({ ch }) => OWN_WORDS.test(ch.name) && optionOfChoice(ch.name, r.options) === undefined);
  return found.length === 1 ? found[0]?.i : undefined;
}

/** What the 等你選擇 dialog shows, as `chooseDialogProblems` judges it. */
export interface ChooseView {
  /** The dialog's text. */
  text: string;
  /** Each radio (or option, when there is no radio) with its accessible name and whether it is selected. */
  choices: { name: string; checked: boolean }[];
  /** How many text fields the dialog shows. */
  textboxes: number;
  /** The dialog's controls, from `controlsFromAriaSnapshot`. */
  controls: string[];
}

const quoteText = (t: string, max = 300) => `"${t.replace(/\s+/g, ' ').trim().slice(0, max)}"`;

/**
 * R9.54's checks on the 等你選擇 dialog of Issue `n`: it lists the record's options (one
 * extra choice is allowed when it is the own-words entry), shows each option, preselects
 * only the recommended one, and offers a way to reply in the person's own words (a text
 * field or an own-words choice). One entry per check, passing or not.
 */
export function chooseDialogProblems(
  view: ChooseView,
  r: Pick<ResolutionRecord, 'options' | 'recommended' | 'url' | 'body'>,
  n: number,
): { rule: 'R9.54'; ok: boolean; message: string }[] {
  const out: { rule: 'R9.54'; ok: boolean; message: string }[] = [];
  const add = (ok: boolean, message: string) => out.push({ rule: 'R9.54', ok, message });
  const dlg = quoteText(view.text);
  const own = ownWordsIndex(view.choices, r);
  const count = view.choices.length;
  add(
    count === r.options.length || (count === r.options.length + 1 && own !== undefined),
    `the 「排除」 dialog of #${n} lists ${count} choices, not the record's ${r.options.length}; dialog: ${dlg}`,
  );
  for (const o of r.options)
    add(
      causeShown(view.text, optionLabel(o.text)),
      `the 「排除」 dialog of #${n} does not show option ${o.n} "${briefRecord(o.text, 80)}"; dialog: ${dlg}`,
    );
  const checked = view.choices
    .map((ch, i) => ({ ch, i }))
    .filter(({ ch }) => ch.checked)
    .map(({ ch, i }) => optionOfChoice(ch.name, r.options) ?? -(i + 1));
  if (r.recommended === undefined)
    add(false, `the record ${r.url} of #${n} marks no option as recommended: ${briefRecord(r.body)}`);
  else
    add(
      checked.length === 1 && checked[0] === r.recommended,
      `the 「排除」 dialog of #${n} preselects ${checked.length ? checked.map((x) => (x > 0 ? `option ${x}` : `choice ${-x} (no option matched)`)).join(', ') : 'nothing'}, not the recommended option ${r.recommended}`,
    );
  add(
    view.textboxes > 0 || own !== undefined,
    `the 「排除」 dialog of #${n} offers no way to reply in your own words (R4.51); controls: ${view.controls.join(', ') || 'none'}; dialog: ${dlg}`,
  );
  return out;
}

/**
 * Whether a comment body holds an own-words reply verbatim (R9.54, R4.51): with Nibfin's
 * hidden markers removed, CRLF read as LF and outer whitespace trimmed, it equals the
 * trimmed reply. Any other added or changed text does not match.
 */
export function ownWordsComment(body: string, reply: string): boolean {
  const text = body
    .replace(/<!--\s*nibfin:[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  return text === reply.replace(/\r\n/g, '\n').trim();
}

/**
 * The latest `pending` comment by last write and the upper-snake cause codes it holds, such as
 * `STAGE_HOST_MEMORY_LOW` (Proposal R4.3, R1.14); undefined when there is no `pending` comment.
 */
export function pendingCause(comments: Comment[]): { url: string; codes: string[] } | undefined {
  const latest = comments
    .filter((c) => PENDING_MARKER.test(markerOf(c.body) ?? ''))
    .sort((a, b) => lastWrite(a) - lastWrite(b) || a.id - b.id)
    .at(-1);
  return latest && { url: latest.html_url, codes: causeCodes(latest.body ?? '') };
}

/**
 * Why R9.54 was not exercised on a product-decision fixture whose finished record has no
 * options: the fixture stopped for some other cause, named from its latest `pending` comment
 * together with the record's class and URL (R1.14).
 */
export function decisionStopNotExercised(
  f: { name: string; n: number },
  r: ResolutionRecord,
  comments: Comment[],
): string {
  const p = pendingCause(comments);
  const cause = !p
    ? 'no pending comment'
    : p.codes.length
      ? `pending cause ${briefRecord(p.codes.join(', '), 120)} (${p.url})`
      : `no cause code in its latest pending comment (${p.url})`;
  const cls = RESOLUTION_CLASSES.find((x) => x.id === r.class)?.name ?? 'no class';
  return `the ${f.name} fixture #${f.n} stopped with ${cause}, and its finished record ${r.url} is classed ${cls} with no options${r.nextSteps ? ' (it gives next steps)' : ''}, so the 等你選擇 dialog was not run`;
}

/** A fixture's Issue element was not found in the view `where` describes (its update marker and refreshes). */
export function elementMissing(f: { name: string; n: number; title: string }, where: string): string {
  return `the ${f.name} fixture #${f.n}'s element "${briefRecord(f.title, 120)}" was not found in the ${where}`;
}
