import { setTimeout as sleep } from 'node:timers/promises';
import { RUNNER_REQUEST_TITLE } from '../../src/host/config.ts';
import type { GitHub } from '../../src/host/github.ts';
import type { Job } from './parse.ts';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => sleep(ms).then(() => undefined) };

/**
 * Polls `probe` until it returns a value or the deadline passes. A deadline throws with
 * the last observed state, so the failure names what was seen.
 */
export async function until<T>(
  description: string,
  probe: () => Promise<{ value?: T; state: string }>,
  deadlineMs: number,
  clock: Clock = realClock,
  intervalMs = 20_000,
): Promise<T> {
  const end = clock.now() + deadlineMs;
  for (;;) {
    const { value, state } = await probe();
    if (value !== undefined) return value;
    if (clock.now() >= end) throw new Error(`${description}: not observed within ${Math.round(deadlineMs / 1000)} s; last observed: ${state}`);
    await clock.sleep(intervalMs);
  }
}

export interface Registration {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels: { name: string }[];
}

export const hasLabel = (r: Registration, label: string) => r.labels.some((l) => l.name === label);

export const registrations = (gh: GitHub, repo: string) => gh.list<Registration>(`/repos/${repo}/actions/runners`, 'runners');

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  created_at: string;
  user: { login: string };
  pull_request?: unknown;
}

/** Runner request Issues the login opened at or after `since` (one minute of clock skew allowed). */
export async function requestIssues(gh: GitHub, repo: string, login: string, since: number): Promise<Issue[]> {
  const all = await gh.list<Issue>(`/repos/${repo}/issues?state=all&creator=${encodeURIComponent(login)}`);
  return all.filter((i) => i.pull_request === undefined && i.title === RUNNER_REQUEST_TITLE && Date.parse(i.created_at) >= since - 60_000);
}

export interface Comment {
  body: string | null;
  user: { login: string };
  created_at: string;
}

export const comments = (gh: GitHub, repo: string, n: number) => gh.list<Comment>(`/repos/${repo}/issues/${n}/comments`);

export interface Run {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  path: string;
  created_at: string;
}

/** Runs created at or after `since` (with a minute of clock skew), so the listing stays short as run history grows. */
export function runs(gh: GitHub, repo: string, query: string, since: number): Promise<Run[]> {
  const created = encodeURIComponent(`>=${new Date(since - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  return gh.list<Run>(`/repos/${repo}/actions/runs?${query}&created=${created}`, 'workflow_runs');
}

export const jobs = (gh: GitHub, repo: string, runId: number) => gh.list<Job>(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest`, 'jobs');

export const jobLog = (gh: GitHub, repo: string, jobId: number) => gh.download(`/repos/${repo}/actions/jobs/${jobId}/logs`).then((r) => r.text);

export interface DeployKey {
  id: number;
  title: string;
  key: string;
  read_only: boolean;
}

export const deployKeys = (gh: GitHub, repo: string) => gh.list<DeployKey>(`/repos/${repo}/keys`);

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
