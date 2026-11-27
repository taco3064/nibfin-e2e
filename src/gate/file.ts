import { E2E_REPO, legMarker, REQUEST_LABEL, runMarker } from '../host/config.ts';
import type { GitHub } from '../host/github.ts';

export const MAX_REASON = 4000;
export const MAX_BODY = 60000;

/** Caps untrusted text before it is fenced. */
export function cap(text: string, max = MAX_REASON): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated, ${text.length - max} more characters)` : text;
}

/** Puts untrusted text in a code fence longer than any backtick run inside it, so it renders only as text. */
export function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}

export interface RequestIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
  labels?: (string | { name?: string })[];
  assignees?: { login?: string }[];
  pull_request?: unknown;
}

export interface Filed {
  title: string;
  decision: 'created' | 'commented' | 'already filed' | 'already commented' | 'failed';
  number?: number;
  url?: string;
  reason: string;
}

/** Everything filing needs, read once per run. */
export interface FilingContext {
  gh: GitHub;
  runId: string;
  /** The run's `created_at`, bounding comment reads. */
  since: string;
  /** The Owner: the account behind `NIBFIN_GITHUB_TOKEN`. */
  owner: string;
  /** Open `request` Issues by exact title, the lowest number first. */
  open: Map<string, RequestIssue>;
  /**
   * Issues of any state that this run already wrote to (its run marker in the body or in a comment
   * since the run started), by title, with the legs marked on them. Read only for the titles the
   * caller passes, so a request a leg filed and Scope then closed is not filed again.
   */
  runIssues: Map<string, RunIssue[]>;
}

export interface RunIssue {
  issue: RequestIssue;
  /** Platforms whose leg marker this run wrote on the Issue, in its body or a comment. */
  legs: Set<string>;
}

export async function openRequests(gh: GitHub): Promise<Map<string, RequestIssue>> {
  const list = await gh.list<RequestIssue>(`/repos/${E2E_REPO}/issues?state=open&labels=${REQUEST_LABEL}`);
  const open = new Map<string, RequestIssue>();
  for (const issue of list) {
    if (issue.pull_request) continue;
    const seen = open.get(issue.title);
    if (!seen || issue.number < seen.number) open.set(issue.title, issue);
  }
  return open;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * This run's Issues with one of `titles`: every Issue updated since the run started (pull requests
 * skipped) whose body, or a comment since the run started, carries the run marker.
 */
export async function runIssues(gh: GitHub, runId: string, since: string, titles: readonly string[]): Promise<Map<string, RunIssue[]>> {
  const out = new Map<string, RunIssue[]>();
  if (!titles.length) return out;
  const wanted = new Set(titles);
  const marker = runMarker(runId);
  const leg = new RegExp(`<!-- nibfin-e2e:run ${escapeRegExp(runId)} leg ([a-z0-9-]+) -->`, 'g');
  const bound = encodeURIComponent(since);
  for (const issue of await gh.list<RequestIssue>(`/repos/${E2E_REPO}/issues?state=all&since=${bound}`)) {
    if (issue.pull_request || !wanted.has(issue.title)) continue;
    const comments = await gh.list<{ body?: string | null }>(`/repos/${E2E_REPO}/issues/${issue.number}/comments?since=${bound}`);
    const ours = [issue.body ?? '', ...comments.map((c) => c.body ?? '')].filter((t) => t.includes(marker));
    if (!ours.length) continue;
    const legs = new Set(ours.flatMap((t) => [...t.matchAll(leg)].map((m) => m[1] as string)));
    out.set(issue.title, [...(out.get(issue.title) ?? []), { issue, legs }]);
  }
  return out;
}

/**
 * Reads what filing needs once. `titles` are the subjects about to be filed; this run's Issues
 * with those titles are looked up in every state (see `runIssues`). Without titles nothing more
 * is read.
 */
export async function filingContext(gh: GitHub, runId: string, since: string, titles: readonly string[] = []): Promise<FilingContext> {
  const { data: me } = await gh.rest<{ login?: string }>('GET', '/user');
  if (!me.login) throw new Error('GitHub GET /user returned no login');
  return { gh, runId, since, owner: me.login, open: await openRequests(gh), runIssues: await runIssues(gh, runId, since, titles) };
}

const labelNames = (issue: RequestIssue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));

export async function readIssue(ctx: FilingContext, number: number): Promise<RequestIssue> {
  return (await ctx.gh.rest<RequestIssue>('GET', `/repos/${E2E_REPO}/issues/${number}`)).data;
}

/** What a read-back found wrong; empty when the Issue is the open, labelled, assigned request. */
export function readBackProblems(issue: RequestIssue, title: string, owner: string): string[] {
  const problems: string[] = [];
  if (issue.title !== title) problems.push(`title is ${JSON.stringify(issue.title)}`);
  if (issue.state !== 'open') problems.push(`state is ${issue.state}`);
  if (!labelNames(issue).includes(REQUEST_LABEL)) problems.push(`label ${REQUEST_LABEL} is missing`);
  if (!(issue.assignees ?? []).some((a) => a.login === owner)) problems.push(`${owner} is not assigned`);
  return problems;
}

/**
 * Puts the run marker first, caps the text, then adds one leg marker per platform the text
 * contains (after the cap, so a long body never loses them).
 */
export function withMarker(ctx: FilingContext, text: string, platforms: readonly string[] = []): string {
  const body = `${runMarker(ctx.runId)}\n${text}`;
  const capped = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n… (truncated)` : body;
  return platforms.length ? `${capped}\n\n${platforms.map((p) => legMarker(ctx.runId, p)).join('\n')}` : capped;
}

export interface Subject {
  title: string;
  /** Body of a new request. */
  body: string;
  /** Comment on an open request with the same title; defaults to the body. */
  comment?: string;
  /**
   * For a failure built from leg results: the platforms of its occurrences and the text for any
   * subset of them. Filing then writes only the legs this run has not yet marked on an Issue
   * with this title, in any state.
   */
  legs?: { platforms: string[]; render(platforms: readonly string[]): string };
}

/**
 * Comments on the open request unless this run already did; returns the re-read Issue.
 * Comment reads are bounded by the run's start.
 */
export async function commentOnce(ctx: FilingContext, issue: RequestIssue, comment: string): Promise<{ decision: 'commented' | 'already commented'; issue: RequestIssue }> {
  const marker = runMarker(ctx.runId);
  const comments = await ctx.gh.list<{ body?: string | null }>(`/repos/${E2E_REPO}/issues/${issue.number}/comments?since=${encodeURIComponent(ctx.since)}`);
  let decision: 'commented' | 'already commented' = 'already commented';
  if (!comments.some((c) => (c.body ?? '').includes(marker))) {
    await ctx.gh.rest('POST', `/repos/${E2E_REPO}/issues/${issue.number}/comments`, { body: withMarker(ctx, comment) });
    decision = 'commented';
  }
  return { decision, issue: await readIssue(ctx, issue.number) };
}

async function create(ctx: FilingContext, title: string, text: string, platforms: readonly string[] = []): Promise<RequestIssue> {
  const { data } = await ctx.gh.rest<RequestIssue>('POST', `/repos/${E2E_REPO}/issues`, {
    title,
    body: withMarker(ctx, text, platforms),
    labels: [REQUEST_LABEL],
    assignees: [ctx.owner],
  });
  const issue = await readIssue(ctx, data.number);
  ctx.open.set(title, issue);
  return issue;
}

function result(issue: RequestIssue, subject: Subject, owner: string, decision: Filed['decision'], reason: string): Filed {
  const problems = readBackProblems(issue, subject.title, owner);
  if (problems.length) {
    return { title: subject.title, decision: 'failed', number: issue.number, url: issue.html_url, reason: `read-back after "${decision}": ${problems.join('; ')}` };
  }
  return { title: subject.title, decision, number: issue.number, url: issue.html_url, reason };
}

/**
 * "Already filed" for an Issue this run wrote to: read back when it is open, reported as closed
 * (without the open-state check) when Scope closed it meanwhile.
 */
async function alreadyFiled(ctx: FilingContext, subject: Subject, number: number, what: string): Promise<Filed> {
  const issue = await readIssue(ctx, number);
  if (issue.state !== 'open') {
    return { title: subject.title, decision: 'already filed', number, url: issue.html_url, reason: `this run filed ${what} on #${number}, which is closed` };
  }
  return result(issue, subject, ctx.owner, 'already filed', `this run filed ${what} on #${number}`);
}

/** Files only the legs of `subject` that no Issue of this run with its title carries yet. */
async function fileLegs(ctx: FilingContext, subject: Subject, legs: NonNullable<Subject['legs']>): Promise<Filed> {
  const own = ctx.runIssues.get(subject.title) ?? [];
  const marked = new Set(own.flatMap((r) => [...r.legs]));
  const missing = legs.platforms.filter((p) => !marked.has(p));
  if (!missing.length) {
    const target = own.find((r) => r.issue.state === 'open') ?? own[0];
    if (target) return alreadyFiled(ctx, subject, target.issue.number, `every leg (${legs.platforms.join(', ')})`);
  }
  const text = legs.render(missing);
  const open = ctx.open.get(subject.title);
  if (open) {
    await ctx.gh.rest('POST', `/repos/${E2E_REPO}/issues/${open.number}/comments`, { body: withMarker(ctx, text, missing) });
    const issue = await readIssue(ctx, open.number);
    if (issue.state === 'open') return result(issue, subject, ctx.owner, 'commented', `reused open request #${open.number} for ${missing.join(', ')}`);
    ctx.open.delete(subject.title);
    const created = await create(ctx, subject.title, text, missing);
    return result(created, subject, ctx.owner, 'created', `#${open.number} was closed while this run commented; filed a new request for ${missing.join(', ')}`);
  }
  const created = await create(ctx, subject.title, text, missing);
  const before = own.length ? `this run's #${own.map((r) => r.issue.number).join(', #')} is closed; ` : '';
  return result(created, subject, ctx.owner, 'created', `${before}no open request with this title; filed ${missing.join(', ')}`);
}

/**
 * Files one subject: reuses the open `request` with the same title by commenting once per
 * run, otherwise creates it with the label and the Owner as assignee in one call, then
 * reads it back. Safe to redo: a re-run attempt of the same run recognizes its marker, and an
 * Issue this run already filed under the title stays the filing even after it was closed.
 * A subject with `legs` is filed per leg (see `fileLegs`).
 */
export async function fileSubject(ctx: FilingContext, subject: Subject): Promise<Filed> {
  try {
    if (subject.legs) return await fileLegs(ctx, subject, subject.legs);
    const open = ctx.open.get(subject.title);
    if (open && (open.body ?? '').includes(runMarker(ctx.runId))) {
      return result(await readIssue(ctx, open.number), subject, ctx.owner, 'already filed', `this run filed #${open.number}`);
    }
    const closed = (ctx.runIssues.get(subject.title) ?? []).find((r) => r.issue.state !== 'open');
    if (closed) return await alreadyFiled(ctx, subject, closed.issue.number, 'this subject');
    if (open) {
      const done = await commentOnce(ctx, open, subject.comment ?? subject.body);
      if (done.issue.state === 'open') {
        return result(done.issue, subject, ctx.owner, done.decision, `reused open request #${open.number}`);
      }
      ctx.open.delete(subject.title);
      const issue = await create(ctx, subject.title, subject.body);
      return result(issue, subject, ctx.owner, 'created', `#${open.number} was closed while this run commented; filed a new request`);
    }
    const issue = await create(ctx, subject.title, subject.body);
    return result(issue, subject, ctx.owner, 'created', 'no open request with this title');
  } catch (error) {
    return { title: subject.title, decision: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
