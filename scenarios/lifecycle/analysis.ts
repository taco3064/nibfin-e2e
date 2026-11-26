// Pure readings of GitHub state: run titles, job windows, logs, activity. No I/O here.
import type { Outcome, RuleId } from '../../src/types.ts';

export const STAGES = ['route', 'scope', 'shape', 'deliver', 'review', 'finish'] as const;
export type Stage = (typeof STAGES)[number];
/** Stages whose Job runs an agent on the Assignee's self-hosted Runner; route and finish run hosted in a public execution repository (Proposal R5.70, R5.72). */
export const AGENT_STAGES: readonly Stage[] = ['scope', 'shape', 'deliver', 'review'];

export interface Run {
  id: number;
  /** The repository the run belongs to (added by the observer). */
  repo: string;
  name: string;
  display_title: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string;
  run_attempt?: number;
  head_sha: string;
  updated_at?: string;
}

export interface Job {
  id: number;
  run_id: number;
  run_attempt?: number;
  name: string;
  status: string;
  conclusion: string | null;
  labels: string[];
  runner_name: string | null;
  created_at?: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason?: string | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  created_at: string;
  closed_at: string | null;
  html_url: string;
  node_id: string;
  id: number;
  pull_request?: unknown;
}

export interface Pull {
  number: number;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
  body: string | null;
  html_url: string;
}

export interface Comment {
  id: number;
  body?: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  html_url: string;
}

export interface Activity {
  id: number;
  ref: string;
  timestamp: string;
  activity_type: string;
  before: string;
  after: string;
}

export interface Runner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels?: { name: string }[];
}

export interface LogLine {
  /** Epoch ms of the line's leading timestamp, when it has one. */
  at?: number;
  text: string;
}

export interface Window {
  issue: string;
  stage: Stage;
  jobId: number;
  runner: string | null;
  start: number;
  /** `Infinity` while the job runs. */
  end: number;
}

export const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

const STAGE_TITLE = /^Nibfin · (.+?)#(\d+) · (route|scope|shape|deliver|review|finish)$/;
const WAKE_TITLE = /^Nibfin · (.+?)#(\d+) · wake$/;
const PUSH_WAKE_TITLE = /@([0-9a-f]{7,40}) · wake$/;

/** `Nibfin · <owner/repo>#<n> · <stage>`, the title of a stage run of `nibfin-shared-runner.yml`. */
export function parseStageTitle(title: string): { repo: string; issue: number; stage: Stage } | undefined {
  const m = STAGE_TITLE.exec(title);
  return m ? { repo: m[1] as string, issue: Number(m[2]), stage: m[3] as Stage } : undefined;
}

export function parseWakeTitle(title: string): { repo: string; issue: number } | undefined {
  const m = WAKE_TITLE.exec(title);
  return m ? { repo: m[1] as string, issue: Number(m[2]) } : undefined;
}

/** The commit a push wake run (`Nibfin · …@<sha> · wake`) is for. */
export function pushWakeSha(title: string): string | undefined {
  return PUSH_WAKE_TITLE.exec(title)?.[1];
}

/** Stage runs in the execution repository for one Issue, oldest first. */
export function stageRuns(runs: Run[], executionRepo: string, issueRepo: string, issue: number, stages: readonly Stage[] = STAGES): (Run & { stage: Stage })[] {
  const out: (Run & { stage: Stage })[] = [];
  for (const r of runs) {
    if (r.repo !== executionRepo) continue;
    const t = parseStageTitle(r.display_title);
    if (t && t.repo === issueRepo && t.issue === issue && stages.includes(t.stage)) out.push({ ...r, stage: t.stage });
  }
  return out.sort((a, b) => time(a.created_at) - time(b.created_at) || a.id - b.id);
}

export function wakeRuns(runs: Run[], issueRepo: string, issue: number): Run[] {
  return runs.filter((r) => {
    const t = parseWakeTitle(r.display_title);
    return t !== undefined && t.repo === issueRepo && t.issue === issue;
  });
}

export const issueKey = (repo: string, n: number) => `${repo}#${n}`;

/** A job's window; a job that has not started has none. */
export function jobWindow(job: Job, issue: string, stage: Stage): Window | undefined {
  const start = time(job.started_at);
  if (Number.isNaN(start) || job.status === 'queued' || job.status === 'waiting' || job.status === 'pending') return undefined;
  const end = job.completed_at ? time(job.completed_at) : Infinity;
  return { issue, stage, jobId: job.id, runner: job.runner_name, start, end };
}

/** Whether a job ran on a self-hosted Runner (the agent job of an agent stage). */
export const selfHosted = (job: Job) => job.labels.includes('self-hosted') || job.labels.some((l) => /^nibfin-\d+$/.test(l));

export const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** Two windows of different Issues on different Runners that overlap. */
export function concurrentPair(windows: Window[]): [Window, Window] | undefined {
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i] as Window;
      const b = windows[j] as Window;
      if (a.issue !== b.issue && a.runner && b.runner && a.runner !== b.runner && overlap(a, b)) return [a, b];
    }
  }
  return undefined;
}

/** Pairs of windows of one Issue that overlap. */
export function sameIssueOverlaps(windows: Window[]): [Window, Window][] {
  const out: [Window, Window][] = [];
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i] as Window;
      const b = windows[j] as Window;
      if (a.issue === b.issue && overlap(a, b)) out.push([a, b]);
    }
  }
  return out;
}

const LOG_LINE = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/;

/** Splits a job log; each line's leading ISO 8601 timestamp, when present, becomes `at`. */
export function parseLog(text: string): LogLine[] {
  return text.split(/\r?\n/).map((line) => {
    const m = LOG_LINE.exec(line);
    if (!m) return { text: line };
    const at = Date.parse(m[1] as string);
    return Number.isNaN(at) ? { text: line } : { at, text: m[2] as string };
  });
}

/** The fix reason the `Run the stage` step shows in its env (`REASON: ci-failure`). */
export function reasonOf(lines: LogLine[]): string | undefined {
  for (const l of lines) {
    const m = /^\s*REASON:\s*(\S+)\s*$/.exec(l.text);
    if (m) return m[1];
  }
  return undefined;
}

export function firstMark(lines: LogLine[], re: RegExp): LogLine | undefined {
  return lines.find((l) => re.test(l.text));
}

/**
 * The window between the first `start` mark and the next `end` mark after it, from
 * the lines' timestamps. Undefined when a mark or a timestamp is missing.
 */
export function markWindow(lines: LogLine[], start: RegExp, end: RegExp): { start: number; end: number } | undefined {
  const i = lines.findIndex((l) => start.test(l.text));
  if (i < 0) return undefined;
  const j = lines.findIndex((l, k) => k > i && end.test(l.text));
  if (j < 0) return undefined;
  const s = lines[i]?.at;
  const e = lines[j]?.at;
  return s === undefined || e === undefined ? undefined : { start: s, end: e };
}

/** Activity types that write a branch: a push, a force push, or the push that creates it. */
export const BRANCH_WRITES = new Set(['push', 'force_push', 'branch_creation']);

/** Branch writes whose timestamp lies inside the window. */
export function pushesWithin(acts: Activity[], w: { start: number; end: number }): Activity[] {
  return acts.filter((a) => BRANCH_WRITES.has(a.activity_type) && time(a.timestamp) >= w.start && time(a.timestamp) <= w.end);
}

/** Whether a branch ref (`refs/heads/…` or bare) is derived from the Issue number: `nibfin/issue-<n>` and its suffixed variants. */
export function isIssueBranch(ref: string, n: number): boolean {
  return new RegExp(`^(refs/heads/)?nibfin/issue-${n}(?![0-9])`).test(ref);
}

const MARKER = /<!--\s*nibfin:([\w.:-]+)/;

/** The hidden marker key of a Nibfin comment (`<!-- nibfin:pending -->` gives `pending`). */
export const markerOf = (body: string | undefined) => (body ? MARKER.exec(body)?.[1] : undefined);

/** Marker keys that appear on more than one comment (R3.42: a redo updates its comment). */
export function duplicateMarkers(comments: Comment[]): string[] {
  const count = new Map<string, number>();
  for (const c of comments) {
    const k = markerOf(c.body);
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
}

/** Whether a job left the queue before `t` (so a hold that starts at `t` cannot be observed). */
export const startedBefore = (job: Job, t: number) => job.status !== 'queued' && !!job.started_at && time(job.started_at) < t;

/**
 * R4.23: while the Runners are offline, the job dispatched while they were online is
 * still queued with the same id and label, and the Issue got no new route or stage run.
 */
export function queuedHoldProblems(recorded: { id: number; label: string; runId: number }, current: Job | undefined, laterRuns: Run[]): string[] {
  const out: string[] = [];
  if (!current) out.push(`job ${recorded.id} is no longer listed`);
  else {
    if (current.status !== 'queued') out.push(`job ${recorded.id} is ${current.status}${current.runner_name ? ` on ${current.runner_name}` : ''}, expected queued`);
    if (!current.labels.includes(recorded.label)) out.push(`job ${recorded.id} has labels ${current.labels.join(', ')}, expected ${recorded.label}`);
  }
  const other = laterRuns.filter((r) => r.id !== recorded.runId);
  if (other.length) out.push(`new runs appeared: ${other.map((r) => `${r.display_title} (${r.id})`).join(', ')}`);
  return out;
}

/**
 * R3.20 for fix Deliver runs started while the first PR was open: every push inside
 * their windows went to that PR's branch, the PR followed the branch after each job,
 * and no other PR used that branch.
 */
export function fixPushProblems(input: {
  branch: string;
  prNumber: number;
  windows: { start: number; end: number; reason: string }[];
  activity: Activity[];
  headsAfter: { reason: string; prHead: string; branchHead: string }[];
  pullsForBranch: number[];
}): string[] {
  const out: string[] = [];
  const want = `refs/heads/${input.branch}`;
  for (const w of input.windows) {
    for (const a of pushesWithin(input.activity, w)) {
      if (a.ref !== want) out.push(`the ${w.reason} Deliver pushed to ${a.ref} at ${a.timestamp}, not ${want}`);
    }
  }
  for (const h of input.headsAfter) {
    if (h.prHead !== h.branchHead) out.push(`after the ${h.reason} Deliver, PR #${input.prNumber}'s head is ${h.prHead} but ${input.branch} is at ${h.branchHead}`);
  }
  const others = input.pullsForBranch.filter((n) => n !== input.prNumber);
  if (others.length) out.push(`other PRs use ${input.branch}: ${others.map((n) => `#${n}`).join(', ')}`);
  return out;
}

/** Collects per-rule problems; a scenario passes only when none was found. */
export class Checks {
  private readonly problems: string[] = [];
  private readonly notes: string[] = [];

  check(rule: RuleId, ok: boolean, problem: string): boolean {
    if (!ok) this.problems.push(`${rule}: ${problem}`);
    return ok;
  }

  /** Records problems from a list; passes when it is empty. */
  none(rule: RuleId, problems: string[]): boolean {
    for (const p of problems) this.problems.push(`${rule}: ${p}`);
    return problems.length === 0;
  }

  fail(rule: RuleId, problem: string): void {
    this.problems.push(`${rule}: ${problem}`);
  }

  /** A rule whose triggering situation did not happen: reported failed, never passed. */
  notExercised(rule: RuleId, why: string): void {
    this.problems.push(`${rule}: not exercised: ${why}`);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  get failed(): boolean {
    return this.problems.length > 0;
  }

  outcome(passed: string): Outcome {
    const notes = this.notes.length ? ` (${this.notes.join('; ')})` : '';
    if (this.problems.length) return { status: 'failed', reason: this.problems.join('; ') + notes };
    return { status: 'passed', reason: passed + notes };
  }
}
