// GitHub-side support for the Dashboard scenarios: fixtures, the quiet-sandbox check and reads.
import type { GitHub } from '../../src/host/github.ts';
import type { ExecResult } from '../../src/host/exec.ts';
import { ALL_FIXTURE_TITLES, FIXTURES, fixtureTitle, labelMismatch, quietProblems } from './checks.ts';
import type { FixtureKey, FixtureSpec, IssueState } from './checks.ts';

export interface Issue extends IssueState {
  id: number;
  node_id: string;
  state: string;
  html_url: string;
  repo: string;
}

interface RawIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  state: string;
  html_url: string;
  labels: ({ name: string } | string)[];
  pull_request?: unknown;
}

const toIssue = (repo: string, r: RawIssue): Issue => ({
  id: r.id,
  node_id: r.node_id,
  number: r.number,
  title: r.title,
  state: r.state,
  html_url: r.html_url,
  labels: r.labels.map((l) => (typeof l === 'string' ? l : l.name)),
  repo,
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `read` until `done` holds or the timeout passes; returns the last value read. */
export async function until<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs: number,
  everyMs = 3000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() >= end) return v;
    await sleep(everyMs);
  }
}

export async function me(gh: GitHub): Promise<string> {
  return (await gh.rest<{ login: string }>('GET', '/user')).data.login;
}

export async function openIssues(gh: GitHub, repo: string): Promise<Issue[]> {
  const raw = await gh.list<RawIssue>(`/repos/${repo}/issues?state=open`);
  return raw.filter((r) => r.pull_request === undefined).map((r) => toIssue(repo, r));
}

export async function readIssue(gh: GitHub, repo: string, number: number): Promise<Issue> {
  return toIssue(repo, (await gh.rest<RawIssue>('GET', `/repos/${repo}/issues/${number}`)).data);
}

export async function blockedBy(gh: GitHub, issue: Issue): Promise<{ id: number; number: number }[]> {
  return gh.list<{ id: number; number: number }>(`/repos/${issue.repo}/issues/${issue.number}/dependencies/blocked_by`);
}

export async function findByTitle(gh: GitHub, repo: string, title: string): Promise<Issue | undefined> {
  const raw = await gh.list<RawIssue>(`/repos/${repo}/issues?state=all`);
  const hit = raw.find((r) => r.pull_request === undefined && r.title === title);
  return hit && toIssue(repo, hit);
}

export interface Sandboxes {
  execution: string;
  peer: string;
}

/** Creates one Issue with its labels and Assignee in the create call, so it is never open without them. */
export async function createIssue(
  gh: GitHub,
  repo: string,
  title: string,
  labels: string[],
  assignee: string,
): Promise<Issue> {
  const body = `Fixture for the nibfin-e2e Dashboard scenarios (nibfin-e2e #298). Created by the gate; the sandbox is reset after the run.`;
  const { data } = await gh.rest<RawIssue>('POST', `/repos/${repo}/issues`, {
    title,
    body,
    labels,
    assignees: [assignee],
  });
  return toIssue(repo, data);
}

export type Fixtures = Record<Exclude<FixtureKey, 'E'>, Issue>;

/**
 * Finds the fixtures by exact title or creates them, then adds and reads back their
 * Blocked by edges. A found fixture whose Nibfin labels differ fails; nothing is re-labelled.
 */
export async function ensureFixtures(
  gh: GitHub,
  sandboxes: Sandboxes,
  specs: FixtureSpec[] = FIXTURES,
): Promise<Fixtures> {
  const login = await me(gh);
  const got = {} as Record<string, Issue>;
  for (const spec of specs) {
    const repo = sandboxes[spec.repo];
    const title = fixtureTitle(spec.key);
    let issue = await findByTitle(gh, repo, title);
    if (issue) {
      const mismatch = labelMismatch(spec, issue.labels);
      if (mismatch) throw new Error(`fixture ${spec.key} (${repo}#${issue.number}) ${mismatch}; it was not changed`);
    } else {
      issue = await createIssue(gh, repo, title, spec.labels, login);
    }
    if (spec.closed && issue.state !== 'closed') {
      await gh.rest('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      issue = await readIssue(gh, repo, issue.number);
    }
    got[spec.key] = issue;
  }
  for (const spec of specs) {
    const issue = got[spec.key] as Issue;
    if (!spec.blockedBy.length) continue;
    let have = await blockedBy(gh, issue);
    for (const key of spec.blockedBy) {
      const blocker = got[key] as Issue;
      if (!have.some((b) => b.id === blocker.id)) {
        await gh.rest('POST', `/repos/${issue.repo}/issues/${issue.number}/dependencies/blocked_by`, {
          issue_id: blocker.id,
        });
      }
    }
    have = await blockedBy(gh, issue);
    const missing = spec.blockedBy.filter((k) => !have.some((b) => b.id === (got[k] as Issue).id));
    if (missing.length)
      throw new Error(
        `fixture ${spec.key} (${issue.repo}#${issue.number}) reads back without Blocked by ${missing.join(', ')}`,
      );
  }
  return got as Fixtures;
}

export interface QuietDeps {
  github: GitHub;
  sandboxes: Sandboxes;
  /** Runs `podman ps --format json`. */
  podmanPs(): Promise<ExecResult>;
  /** How long to wait for queued and in-progress runs to finish (the fixtures' own route runs). */
  runsTimeoutMs?: number;
  log?(message: string): void;
}

/**
 * Read-only precondition: nothing outside this Issue's fixtures can start a local agent
 * Job. Throws, naming each item, when earlier work in the sandboxes is still active.
 */
export async function assertQuietSandboxes(deps: QuietDeps): Promise<void> {
  const { github: gh, sandboxes } = deps;
  const r = `/repos/${sandboxes.execution}`;
  const active = async () => {
    const runs: { id: number; name: string; status: string }[] = [];
    for (const status of ['queued', 'in_progress']) {
      runs.push(
        ...(await gh.list<{ id: number; name: string; status: string }>(
          `${r}/actions/runs?status=${status}`,
          'workflow_runs',
        )),
      );
    }
    return runs;
  };
  const runs = await until(active, (x) => x.length === 0, deps.runsTimeoutMs ?? 300_000, 10_000);
  const ps = await deps.podmanPs();
  if (ps.code !== 0) throw new Error(`podman ps exited ${ps.code}: ${ps.stderr.trim().slice(-500)}`);
  const containers = (JSON.parse(ps.stdout.trim() || '[]') as { Image?: string; Names?: string[] | string }[]).map(
    (c) => ({
      image: String(c.Image ?? ''),
      name: Array.isArray(c.Names) ? c.Names.join(',') : String(c.Names ?? ''),
    }),
  );
  const problems = quietProblems({
    containers,
    issues: [
      { repo: sandboxes.execution, issues: await openIssues(gh, sandboxes.execution) },
      { repo: sandboxes.peer, issues: await openIssues(gh, sandboxes.peer) },
    ],
    pulls: (await gh.list<{ number: number }>(`${r}/pulls?state=open`)).map((p) => p.number),
    runs,
    fixtures: ALL_FIXTURE_TITLES,
  });
  if (problems.length) {
    throw new Error(
      `precondition: earlier work in the sandboxes is still active, so local Jobs cannot be attributed; nothing was written and nothing is asserted about the product: ${problems.join('; ')}`,
    );
  }
}
