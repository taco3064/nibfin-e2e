import type { GitHub } from '../../src/host/github.ts';
import type { RunContext, Scenario } from '../../src/types.ts';
import { Check, precondition, redact, tail } from '../lib/check.ts';
import { isNibfinRunFor } from '../lib/gh.ts';
import { createIssue, deleteFile, json, putFile, readFile, registrations, whoami } from '../lib/github.ts';
import type { Issue } from '../lib/github.ts';
import { statusValidator } from '../lib/schema.ts';
import { waitFor } from '../lib/wait.ts';

const ISSUE_WF = '.github/workflows/nibfin-issue.yml';

interface StatusIssue {
  number: number;
  blockedBy?: { repo: string; number: number; state: string }[] | null;
  runs?: { url: string }[] | null;
}

interface NibfinRepo {
  repo: string;
  execution: boolean | null;
}

interface Host {
  host: { running: boolean };
  runners: { runners: { provider: string; active?: boolean; status?: string }[] | null };
  providers: { provider: string; loggedIn: boolean }[] | null;
}

interface PersonView {
  host: Host;
  repos: { repo: string; permission: string | null; issues: StatusIssue[] | null }[] | null;
  nibfinRepos: NibfinRepo[] | null;
}

interface RepoView {
  host: Host;
  issues: StatusIssue[] | null;
  permission: string | null;
  nibfinRun: { usesNibfin: boolean; commit?: string; succeeded: boolean };
  nibfinRepos: NibfinRepo[] | null;
}

export interface Run {
  id: number;
  run_attempt: number;
  display_title: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

const runs = async (gh: GitHub, repo: string, since: string) =>
  (await gh.rest<{ workflow_runs: Run[] }>('GET', `/repos/${repo}/actions/runs?per_page=100&created=${encodeURIComponent('>=' + since)}`)).data.workflow_runs;

const isNibfin = (r: Run) => r.display_title.startsWith('Nibfin');

/** The statuses of a run that is not finished; the API filter takes one value per call. */
const UNFINISHED = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

/** Every Nibfin run of `repo` that is queued, in progress or otherwise not finished. */
async function unfinishedRuns(gh: GitHub, repo: string): Promise<Run[]> {
  const out: Run[] = [];
  for (const s of UNFINISHED) out.push(...(await gh.list<Run>(`/repos/${repo}/actions/runs?status=${s}`, 'workflow_runs')).filter(isNibfin));
  return out;
}

/** Every Nibfin run of `repo` created at or after `since` (a GitHub timestamp), all pages. */
async function nibfinRunsSince(gh: GitHub, repo: string, since: string): Promise<Run[]> {
  return (await gh.list<Run>(`/repos/${repo}/actions/runs?created=${encodeURIComponent('>=' + since)}`, 'workflow_runs')).filter(isNibfin);
}

/** A run attempt's identity: a re-run keeps the id and raises `run_attempt`. */
const runKey = (r: Pick<Run, 'id' | 'run_attempt'>) => `${r.id}:${r.run_attempt}`;

/** The keys of the runs that were completed when `runs` was read; unfinished runs are left out. */
export function completedKeys(runs: Run[]): Set<string> {
  return new Set(runs.filter((r) => r.status === 'completed').map(runKey));
}

/**
 * The runs that may have written during the window: every run not completed at the
 * baseline read (its key is missing) and every run not completed now. Leans toward
 * overlap, because an overlap only leads to a retry or a reported failure, never a pass.
 */
export function overlapping(baseline: Set<string>, runs: Run[]): Run[] {
  const seen = new Set<string>();
  const out: Run[] = [];
  for (const r of runs) {
    const key = runKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!baseline.has(key) || r.status !== 'completed') out.push(r);
  }
  return out;
}

export const FIELDS = ['labels', 'issues', 'pulls', 'secrets', 'variables', 'runners'] as const;
export type Field = (typeof FIELDS)[number];
export type Snapshot = Record<string, Partial<Record<Field, string[]>>>;

/** One line per changed repository and field with the entries added and removed; `[]` when nothing changed. */
export function snapshotDiff(before: Snapshot, after: Snapshot): string[] {
  const lines: string[] = [];
  const repos = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const show = (xs: string[]) => `[${xs.map(redact).join(', ')}]`;
  for (const repo of repos) {
    for (const field of FIELDS) {
      const b = before[repo]?.[field] ?? [];
      const a = after[repo]?.[field] ?? [];
      const inB = new Set(b);
      const inA = new Set(a);
      const added = a.filter((x) => !inB.has(x));
      const removed = b.filter((x) => !inA.has(x));
      if (!added.length && !removed.length) continue;
      const parts = [added.length ? `added ${show(added)}` : '', removed.length ? `removed ${show(removed)}` : ''].filter(Boolean);
      lines.push(`${repo} ${field}: ${parts.join('; ')}`);
    }
  }
  return lines;
}

export type R542Decision = { kind: 'pass' } | { kind: 'retry' } | { kind: 'fail'; reason: string };

/** What one R5.42 measurement means: an unexplained change fails at once; a change while Nibfin runs overlapped is measured again. */
export function r542Decision(m: { diff: string[]; overlapUrls: string[]; attempt: number; maxAttempts: number }): R542Decision {
  if (!m.diff.length) return { kind: 'pass' };
  if (!m.overlapUrls.length) {
    return { kind: 'fail', reason: `status changed GitHub state of the sandboxes with no Nibfin run overlapping: ${m.diff.join('; ')}` };
  }
  if (m.attempt < m.maxAttempts) return { kind: 'retry' };
  return {
    kind: 'fail',
    reason: `GitHub state of the sandboxes changed across two status calls while Nibfin runs overlapped (cause not shown to be status): ${m.diff.join('; ')}; overlapping runs: ${m.overlapUrls.join(', ')}`,
  };
}

const MAX_ATTEMPTS = 3;

/** Everything `status` must leave as it is (Proposal R5.42); runner busy/online state is GitHub's own and not compared. */
async function snapshot(gh: GitHub, repos: string[]): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const repo of repos) {
    const r = `/repos/${repo}`;
    const issues = await gh.list<{ number: number; labels: { name: string }[]; pull_request?: unknown }>(`${r}/issues?state=open`);
    out[repo] = {
      labels: (await gh.list<{ name: string }>(`${r}/labels`)).map((l) => l.name).sort(),
      issues: issues.map((i) => `${i.number}:${i.labels.map((l) => l.name).sort().join('+')}`).sort(),
      pulls: (await gh.list<{ number: number }>(`${r}/pulls?state=all`)).map((p) => String(p.number)).sort(),
      // Names only: a secret's value is never read.
      secrets: (await gh.list<{ name: string }>(`${r}/actions/secrets`, 'secrets')).map((s) => s.name).sort(),
      variables: (await gh.list<{ name: string; value: string }>(`${r}/actions/variables`, 'variables')).map((v) => `${v.name}=${v.value}`).sort(),
      runners: (await registrations(gh, repo)).map((x) => `${x.id}:${x.name}:${x.labels.map((l) => l.name).sort().join('+')}`).sort(),
    };
  }
  return out;
}

async function status<T>(ctx: RunContext, args: string[]): Promise<T> {
  const r = await ctx.ghNibfin(['status', ...args, '--json']);
  if (r.code !== 0) throw new Error(`gh nibfin status ${args.join(' ')} --json exited ${r.code}: ${tail(r)}`);
  return json<T>(r.stdout, 'status --json');
}

const lower = (s: unknown) => String(s).toLowerCase();

export const statusViews: Scenario = {
  id: 'status-views',
  rules: ['R5.42', 'R5.43', 'R5.44', 'R5.45', 'R5.46', 'R5.47', 'R5.48', 'R5.49', 'R5.50'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const gh = ctx.github;
    const { execution, peer } = ctx.sandbox;
    const validate = statusValidator(ctx.workPath('gh-nibfin'));
    const me = await whoami(gh);

    // Fixtures: A (scope + pause, so Nibfin starts no work, Proposal R4.12) is blocked by C (open) and B (closed, in peer).
    const issueC = await createIssue(gh, execution, { title: 'e2e status: open blocker' });
    const issueA = await createIssue(gh, execution, { title: 'e2e status: blocked Issue', labels: ['scope', 'pause'], assignees: [me.login] });
    const issueB = await createIssue(gh, peer, { title: 'e2e status: closed blocker in peer' });
    await gh.rest('PATCH', `/repos/${peer}/issues/${issueB.number}`, { state: 'closed' });
    for (const blocker of [issueC, issueB]) {
      await gh.rest('POST', `/repos/${execution}/issues/${issueA.number}/dependencies/blocked_by`, { issue_id: blocker.id });
    }
    const issueP: Issue = await createIssue(gh, execution, { title: 'e2e status: assigned without scope', assignees: [me.login] });

    const run = (await waitFor(
      async () => (await runs(gh, execution, issueA.created_at)).find((r) => r.status === 'completed' && isNibfinRunFor(r.display_title, issueA.number)),
      (r) => r !== undefined,
      { what: `a completed Nibfin run for #${issueA.number} on ${execution}`, deadlineMs: 10 * 60_000, intervalMs: 15_000, signal: ctx.signal },
    )) as Run;
    const { data: commits } = await gh.rest<{ sha: string; commit: { committer: { date: string } } }[]>(
      'GET',
      `/repos/${execution}/commits?sha=main&path=${encodeURIComponent(ISSUE_WF)}&per_page=1`,
    );
    const lastChange = commits[0];
    if (!lastChange) return { status: 'failed', reason: `precondition not reached: no commit on ${execution} main touched ${ISSUE_WF}` };
    await waitFor(
      async () => (await runs(gh, execution, lastChange.commit.committer.date)).find((r) => r.conclusion === 'success' && r.display_title.startsWith('Nibfin')),
      (r) => r !== undefined,
      { what: `a successful Nibfin run on ${execution} after ${lastChange.sha.slice(0, 7)}`, deadlineMs: 10 * 60_000, intervalMs: 15_000, signal: ctx.signal },
    );

    // R5.42 measures only the two status calls: start with no Nibfin run unfinished, and count
    // every run not completed at the baseline read as overlapping the window.
    const sandboxes = [execution, peer];
    const since = issueA.created_at;
    let person!: PersonView;
    let repoView!: RepoView;
    for (let attempt = 1; ; attempt++) {
      try {
        await waitFor(
          async () => (await Promise.all(sandboxes.map((r) => unfinishedRuns(gh, r)))).flat().map((r) => r.html_url),
          (urls) => urls.length === 0,
          { what: `no unfinished Nibfin run on ${execution} or ${peer}`, deadlineMs: 10 * 60_000, intervalMs: 15_000, signal: ctx.signal },
        );
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        return precondition(error instanceof Error ? error.message : String(error));
      }
      const baseline = completedKeys((await Promise.all(sandboxes.map((r) => nibfinRunsSince(gh, r, since)))).flat());
      const before = await snapshot(gh, sandboxes);
      person = await status<PersonView>(ctx, []);
      repoView = await status<RepoView>(ctx, ['-R', execution]);
      const after = await snapshot(gh, sandboxes);
      const diff = snapshotDiff(before, after);
      const listing = (await Promise.all(sandboxes.map(async (r) => [...(await nibfinRunsSince(gh, r, since)), ...(await unfinishedRuns(gh, r))]))).flat();
      const overlapUrls = overlapping(baseline, listing).map((r) => r.html_url);
      const decision = r542Decision({ diff, overlapUrls, attempt, maxAttempts: MAX_ATTEMPTS });
      if (decision.kind === 'retry') continue;
      if (decision.kind === 'fail') c.fail('R5.42', decision.reason);
      break;
    }

    for (const [name, v] of [['person', person], ['repo', repoView]] as const) {
      const errors = validate(v);
      c.that(!errors.length, 'R5.47', `the ${name} view does not match status.schema.json: ${errors.join('; ')}`);
      const host = v.host;
      c.that(host?.host?.running === true, 'R5.43', `the ${name} view shows the host not running`);
      const claude = (host?.runners?.runners ?? []).filter((r) => r.provider === 'claude');
      c.that(
        claude.length === 2 && claude.every((r) => r.active === true && r.status === 'online'),
        'R5.43',
        `the ${name} view lists ${claude.length} claude Runners (${claude.map((r) => `${r.active ? 'active' : 'inactive'}/${r.status}`).join(', ')}), expected 2 active and online`,
      );
      const login = (host?.providers ?? []).find((p) => p.provider === 'claude');
      c.that(login?.loggedIn === true, 'R5.43', `the ${name} view shows claude ${login ? 'not logged in' : 'missing from providers'}`);
      const repos = v.nibfinRepos ?? [];
      const ex = repos.find((r) => r.repo === execution);
      const pe = repos.find((r) => r.repo === peer);
      c.that(!!ex && !!pe, 'R5.46', `the ${name} view's nibfinRepos lists [${repos.map((r) => r.repo).join(', ')}], expected both sandboxes`);
      c.that(ex?.execution === true && pe?.execution !== true, 'R5.46', `nibfinRepos marks execution ${String(ex?.execution)} for ${execution} and ${String(pe?.execution)} for ${peer}`);
    }

    const execRepo = (person.repos ?? []).find((r) => r.repo === execution);
    const listed = (execRepo?.issues ?? []).map((i) => i.number);
    c.that(listed.includes(issueA.number) && !listed.includes(issueP.number), 'R5.48', `the person view lists ${execution} Issues [${listed.join(', ')}]; expected #${issueA.number} (scope, assigned) and not #${issueP.number} (no scope)`);
    c.that(lower(execRepo?.permission) === 'admin', 'R5.45', `the person view shows permission ${String(execRepo?.permission)} on ${execution}, expected admin`);
    c.that(lower(repoView.permission) === 'admin', 'R5.45', `the repo view shows permission ${String(repoView.permission)}, expected admin`);

    const a = (execRepo?.issues ?? []).find((i) => i.number === issueA.number);
    const blockers = a?.blockedBy ?? [];
    const hasC = blockers.some((b) => b.repo === execution && b.number === issueC.number && lower(b.state) === 'open');
    const hasB = blockers.some((b) => b.repo === peer && b.number === issueB.number && lower(b.state) === 'closed');
    c.that(hasC && hasB, 'R5.44', `#${issueA.number} blockedBy is ${JSON.stringify(blockers)}; expected ${execution}#${issueC.number} open and ${peer}#${issueB.number} closed`);
    c.that((a?.runs ?? []).some((r) => r.url === run.html_url), 'R5.44', `#${issueA.number} runs do not include ${run.html_url}`);

    const repoListed = (repoView.issues ?? []).map((i) => i.number);
    for (const n of [issueA.number, issueC.number, issueP.number]) c.that(repoListed.includes(n), 'R5.49', `the repo view does not list open Issue #${n}`);
    const nr = repoView.nibfinRun;
    const commit = nr?.commit ?? '';
    c.that(nr?.usesNibfin === true && nr.succeeded === true, 'R5.49', `the repo view's nibfinRun is ${JSON.stringify(nr)}, expected usesNibfin and succeeded`);
    c.that(commit.length >= 7 && lastChange.sha.startsWith(commit), 'R5.49', `nibfinRun.commit is ${commit || 'empty'}, expected ${lastChange.sha} (last change of ${ISSUE_WF})`);

    // R5.50: a repository uses Nibfin exactly while its default branch has nibfin-issue.yml, whoever wrote it.
    const file = await readFile(gh, peer, ISSUE_WF);
    if (!file) {
      c.fail('R5.50', `${peer} has no ${ISSUE_WF} on main`);
      return c.outcome('');
    }
    let restored = false;
    try {
      await deleteFile(gh, peer, ISSUE_WF, 'nibfin-e2e: remove nibfin-issue.yml to check status');
      await c.part('R5.50', async () => {
        await waitFor(() => status<PersonView>(ctx, []), (v) => !(v.nibfinRepos ?? []).some((r) => r.repo === peer), {
          what: `nibfinRepos without ${peer} after deleting its ${ISSUE_WF}`,
          deadlineMs: 2 * 60_000,
          signal: ctx.signal,
          intervalMs: 15_000,
        });
      });
      await putFile(gh, peer, ISSUE_WF, file.text, 'nibfin-e2e: restore nibfin-issue.yml by hand');
      restored = true;
      await c.part('R5.50', async () => {
        await waitFor(() => status<PersonView>(ctx, []), (v) => (v.nibfinRepos ?? []).some((r) => r.repo === peer), {
          what: `nibfinRepos with ${peer} after committing ${ISSUE_WF} by hand`,
          deadlineMs: 2 * 60_000,
          signal: ctx.signal,
          intervalMs: 15_000,
        });
      });
    } finally {
      if (!restored) await putFile(gh, peer, ISSUE_WF, file.text, 'nibfin-e2e: restore nibfin-issue.yml by hand');
    }
    return c.outcome(`both status views match the schema and report host, Runners, login, Issues, blockers, runs, permission and Nibfin repositories; status wrote nothing`);
  },
};
