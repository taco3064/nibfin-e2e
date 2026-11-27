import { E2E_REPO, REQUEST_LABEL, runMarker } from '../host/config.ts';
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

export async function filingContext(gh: GitHub, runId: string, since: string): Promise<FilingContext> {
  const { data: me } = await gh.rest<{ login?: string }>('GET', '/user');
  if (!me.login) throw new Error('GitHub GET /user returned no login');
  return { gh, runId, since, owner: me.login, open: await openRequests(gh) };
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

export function withMarker(ctx: FilingContext, text: string): string {
  const body = `${runMarker(ctx.runId)}\n${text}`;
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n… (truncated)` : body;
}

export interface Subject {
  title: string;
  /** Body of a new request. */
  body: string;
  /** Comment on an open request with the same title; defaults to the body. */
  comment?: string;
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

async function create(ctx: FilingContext, subject: Subject): Promise<RequestIssue> {
  const { data } = await ctx.gh.rest<RequestIssue>('POST', `/repos/${E2E_REPO}/issues`, {
    title: subject.title,
    body: withMarker(ctx, subject.body),
    labels: [REQUEST_LABEL],
    assignees: [ctx.owner],
  });
  const issue = await readIssue(ctx, data.number);
  ctx.open.set(subject.title, issue);
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
 * Files one subject: reuses the open `request` with the same title by commenting once per
 * run, otherwise creates it with the label and the Owner as assignee in one call, then
 * reads it back. Safe to redo: a re-run attempt of the same run recognizes its marker.
 */
export async function fileSubject(ctx: FilingContext, subject: Subject): Promise<Filed> {
  try {
    const open = ctx.open.get(subject.title);
    if (open) {
      if ((open.body ?? '').includes(runMarker(ctx.runId))) {
        return result(await readIssue(ctx, open.number), subject, ctx.owner, 'already filed', `this run filed #${open.number}`);
      }
      const done = await commentOnce(ctx, open, subject.comment ?? subject.body);
      if (done.issue.state === 'open') {
        return result(done.issue, subject, ctx.owner, done.decision, `reused open request #${open.number}`);
      }
      ctx.open.delete(subject.title);
      const issue = await create(ctx, subject);
      return result(issue, subject, ctx.owner, 'created', `#${open.number} was closed while this run commented; filed a new request`);
    }
    const issue = await create(ctx, subject);
    return result(issue, subject, ctx.owner, 'created', 'no open request with this title');
  } catch (error) {
    return { title: subject.title, decision: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
