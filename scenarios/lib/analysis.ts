// Pure readings of GitHub state the Issue-fixture waits share: run titles, stage runs, comment
// markers and per-rule checks. No I/O here.
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
  /** The workflow file, `.github/workflows/<file>.yml`, possibly with an `@<ref>` suffix. */
  path?: string;
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
  /** `GitHub Actions` for a GitHub-hosted runner; null while no runner took the job. */
  runner_group_name?: string | null;
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
  updated_at?: string;
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
  updated_at?: string;
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

export const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

const STAGE_TITLE = /^Nibfin · (.+?)#(\d+) · (route|scope|shape|deliver|review|finish)$/;
const WAKE_TITLE = /^Nibfin · (.+?)#(\d+) · wake$/;

/** `Nibfin · <owner/repo>#<n> · <stage>`, the title of a stage run of `nibfin-shared-runner.yml`. */
export function parseStageTitle(title: string): { repo: string; issue: number; stage: Stage } | undefined {
  const m = STAGE_TITLE.exec(title);
  return m ? { repo: m[1] as string, issue: Number(m[2]), stage: m[3] as Stage } : undefined;
}

export function parseWakeTitle(title: string): { repo: string; issue: number } | undefined {
  const m = WAKE_TITLE.exec(title);
  return m ? { repo: m[1] as string, issue: Number(m[2]) } : undefined;
}

/** Stage runs in the execution repository for one Issue, oldest first. */
export function stageRuns(
  runs: Run[],
  executionRepo: string,
  issueRepo: string,
  issue: number,
  stages: readonly Stage[] = STAGES,
): (Run & { stage: Stage })[] {
  const out: (Run & { stage: Stage })[] = [];
  for (const r of runs) {
    if (r.repo !== executionRepo) continue;
    const t = parseStageTitle(r.display_title);
    if (t && t.repo === issueRepo && t.issue === issue && stages.includes(t.stage)) out.push({ ...r, stage: t.stage });
  }
  return out.sort((a, b) => time(a.created_at) - time(b.created_at) || a.id - b.id);
}

/** Whether a job ran on a self-hosted Runner (the agent job of an agent stage). */
export const selfHosted = (job: Job) =>
  job.labels.includes('self-hosted') || job.labels.some((l) => /^nibfin-\d+$/.test(l));

const MARKER = /<!--\s*nibfin:([\w.:-]+)/;

/** The hidden marker key of a Nibfin comment (`<!-- nibfin:pending -->` gives `pending`). */
export const markerOf = (body: string | undefined) => (body ? MARKER.exec(body)?.[1] : undefined);

/**
 * What a wait read from an Issue's comments, for a failure message (Proposal R1.14):
 * the count, then per comment its marker key (or `no marker`) and the start of its text
 * without hidden `<!-- … -->` markers, cut to about 80 characters. With `stamps`, each
 * comment also names its created and updated times and its URL, so two comments with
 * the same key can be told apart. Secrets are not handled here.
 */
export function describeComments(comments: Comment[], options: { stamps?: boolean } = {}): string {
  const head = `read ${comments.length} comment${comments.length === 1 ? '' : 's'}`;
  if (!comments.length) return head;
  const each = comments.map((c, i) => {
    const text = (c.body ?? '')
      .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const start = text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
    const marker = markerOf(c.body);
    const stamps = options.stamps ? ` (created ${c.created_at}, updated ${c.updated_at}, ${c.html_url})` : '';
    return `#${i + 1} ${marker ? `marker ${marker}` : 'no marker'}${stamps} "${start}"`;
  });
  return `${head}: ${each.join('; ')}`;
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
