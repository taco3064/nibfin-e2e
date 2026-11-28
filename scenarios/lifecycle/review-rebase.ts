// Proposal R3.54: Review sends a PR to Deliver for a rebase only when it really conflicts
// with its base; a PR that is only behind merges through the normal merge flow.
//
// Two fixtures run side by side. Each one's PR CI is held (the sandbox CI's `holdTag`
// hook) so the PR stays open with `test` pending while the harness advances `main`
// through a short-lived PR of its own: the `e2e-ci` ruleset refuses direct pushes to
// main. The behind fixture gets a commit to a file it does not touch; the conflict
// fixture gets an add of its own new source file with a different first line.
import type { Scenario } from '../../src/types.ts';
import { Checks, reasonOf, time } from './analysis.ts';
import type { Activity, Pull, Stage } from './analysis.ts';
import { DEADLINE, changeRequest, lifecycle, message } from './kit.ts';
import type { Kit } from './kit.ts';
import { waitFor } from '../lib/wait.ts';

const RULE = 'R3.54';

/** The merge method for the harness PR: the repository's allowed methods, rebase first. */
export function mergeMethod(repo: {
  allow_rebase_merge?: boolean;
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
}): 'rebase' | 'squash' | 'merge' | undefined {
  if (repo.allow_rebase_merge) return 'rebase';
  if (repo.allow_squash_merge) return 'squash';
  if (repo.allow_merge_commit) return 'merge';
  return undefined;
}

export interface DeliverJob {
  id: number;
  started_at: string | null;
  /** The job's REASON line, when read. */
  reason?: string;
}

export interface RebaseEvidence {
  /** The fixture Issue, for messages. */
  issue: string;
  branch: string;
  /** When `main` advanced (the harness PR's `merged_at`, GitHub's clock). */
  at: number;
  /** The commit `main` advanced to. */
  sha: string;
  /** The fixture's deliver agent jobs. */
  delivers: DeliverJob[];
  /** The fixture Issue's stage runs (every stage), oldest first. */
  runs: { id: number; stage: Stage; created_at: string }[];
  /** Force pushes to the fixture's branch. */
  forced: Pick<Activity, 'timestamp' | 'before' | 'after'>[];
  /** The fixture's merged PR, if any. */
  merged?: { number: number; head: string; merged_at: string | null };
  /** Whether the merged head descends from `sha`. */
  descends: boolean;
  delivered: boolean;
}

const after = (iso: string | null | undefined, at: number) => time(iso) >= at;
const forcedAfter = (e: RebaseEvidence) => e.forced.filter((a) => after(a.timestamp, e.at));

/**
 * Why the half's situation did not happen, if it did not: its PR merged before main
 * advanced, or (behind half) no review run saw the PR after main advanced.
 */
export function notExercisedWhy(kind: 'behind' | 'conflict', e: RebaseEvidence): string | undefined {
  if (e.merged && !after(e.merged.merged_at, e.at))
    return `${e.issue}'s PR #${e.merged.number} merged at ${String(e.merged.merged_at)}, before main advanced to ${e.sha}`;
  if (kind === 'behind' && !e.runs.some((r) => r.stage === 'review' && after(r.created_at, e.at)))
    return `no review run of ${e.issue} was created after main advanced to ${e.sha}`;
  return undefined;
}

/** What breaks R3.54 for a PR that was only behind: any Deliver, force push or rebase after main advanced. */
export function behindProblems(e: RebaseEvidence): string[] {
  const out: string[] = [];
  if (!e.delivered) out.push(`${e.issue} did not close with delivered`);
  const late = e.delivers.filter((j) => after(j.started_at, e.at));
  if (late.length)
    out.push(
      `${e.issue} was behind only, yet deliver job${late.length > 1 ? 's' : ''} ${late.map((j) => `${j.id} (REASON ${j.reason ?? 'unknown'}, started ${String(j.started_at)})`).join(', ')} started after main advanced to ${e.sha}`,
    );
  const forced = forcedAfter(e);
  if (forced.length)
    out.push(
      `${e.branch} was force-pushed after main advanced: ${forced.map((a) => `${a.before.slice(0, 7)}→${a.after.slice(0, 7)} at ${a.timestamp}`).join(', ')}`,
    );
  if (!e.merged) out.push(`${e.issue} has no merged PR`);
  else if (e.descends)
    out.push(
      `the merged head ${e.merged.head} of PR #${e.merged.number} descends from ${e.sha}: the PR was rebased though it did not conflict`,
    );
  return out;
}

/**
 * The REASON values a conflict rebase Deliver may carry: `conflict` was seen in a real
 * run, `rebase` is kept as another name for it. Any other value fails with its name.
 */
export const CONFLICT_REASONS: readonly string[] = ['conflict', 'rebase'];

/**
 * The first deliver job that started at or after the conflicting commit, and the
 * fixture's stage runs created between that commit and the job's start.
 */
export function conflictWindow(e: RebaseEvidence): { first?: DeliverJob; runs: RebaseEvidence['runs'] } {
  const first = e.delivers
    .filter((j) => after(j.started_at, e.at))
    .sort((a, b) => time(a.started_at) - time(b.started_at))[0];
  if (!first) return { runs: [] };
  return {
    first,
    runs: e.runs.filter((r) => after(r.created_at, e.at) && time(r.created_at) <= time(first.started_at)),
  };
}

/** Stage runs as `<id> <stage> <created_at>` joined by commas, or `none`. */
export function seenRuns(runs: RebaseEvidence['runs']): string {
  return runs.length ? runs.map((r) => `${r.id} ${r.stage} ${r.created_at}`).join(', ') : 'none';
}

/**
 * What breaks R3.54 for a PR that really conflicted: the first Deliver after the
 * conflicting commit does not carry a conflict-rebase REASON, no force push, or a merged
 * head without the conflicting commit. Whichever Core stage (route, review or finish)
 * dispatched that Deliver is accepted, since Core picks the stage from the GitHub state
 * (R4.35).
 */
export function conflictProblems(e: RebaseEvidence): string[] {
  const out: string[] = [];
  const { first, runs } = conflictWindow(e);
  if (!first) out.push(`no deliver job for ${e.issue} started after the conflicting commit ${e.sha}`);
  else if (!CONFLICT_REASONS.includes(first.reason ?? ''))
    out.push(
      `the first deliver job ${first.id} of ${e.issue} after the conflicting commit ${e.sha} carries REASON ${first.reason ?? 'unknown'}, not a conflict rebase (${CONFLICT_REASONS.join(' or ')}) (started ${String(first.started_at)}); stage runs in that window: ${seenRuns(runs)}`,
    );
  if (!forcedAfter(e).length) out.push(`${e.branch} was not force-pushed after the conflicting commit`);
  if (!e.merged) out.push(`${e.issue} has no merged PR`);
  else if (!e.descends)
    out.push(
      `the merged head ${e.merged.head} of PR #${e.merged.number} does not descend from the conflicting commit ${e.sha}`,
    );
  if (!e.delivered) out.push(`${e.issue} did not close with delivered`);
  return out;
}

/** How long `settledMergeable` keeps reading, and the pause between its reads. */
export const SETTLE_MS = 30_000;
const SETTLE_INTERVAL_MS = 5_000;

type Mergeable = { mergeable?: boolean | null; mergeable_state?: string };

export interface Settled {
  mergeable?: boolean | null;
  state?: string;
  /** How many reads were made. */
  reads: number;
  /** Whether `mergeable` became `true` or `false` within the bound. */
  settled: boolean;
  /** The last read's error, if the last read failed. */
  error?: string;
}

/**
 * Reads a PR's `mergeable` until it is no longer `null` (GitHub computes it in the
 * background), for at most `SETTLE_MS`. It never fails on the bound or a read error:
 * it then returns the last value read with `settled: false`. An abort still propagates.
 */
export async function settledMergeable(
  read: () => Promise<Mergeable>,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<Settled> {
  let reads = 0;
  let last: Mergeable | undefined;
  let error: string | undefined;
  const counted = async () => {
    reads++;
    try {
      last = await read();
      error = undefined;
      return last;
    } catch (e) {
      error = message(e);
      throw e;
    }
  };
  try {
    const v = await waitFor(counted, (m) => m.mergeable !== null && m.mergeable !== undefined, {
      what: 'mergeable to settle',
      deadlineMs: SETTLE_MS,
      intervalMs: SETTLE_INTERVAL_MS,
      ...opts,
    });
    return { mergeable: v.mergeable, state: v.mergeable_state, reads, settled: true };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return { mergeable: last?.mergeable, state: last?.mergeable_state, reads, settled: false, ...(error ? { error } : {}) };
  }
}

interface HalfSpec {
  kind: 'behind' | 'conflict';
  slug: string;
  title: string;
  fn: string;
  behaviour: string;
}

type Held = Pull & { mergeable?: boolean | null; mergeable_state?: string };

/**
 * Advances `main` through a harness PR from `branch` and merges it. Returns `'merged'`
 * (and closes the harness PR) if the fixture PR merged first.
 */
async function advanceMain(
  k: Kit,
  branch: string,
  files: Record<string, string>,
  msg: string,
  fixturePr: number,
): Promise<{ at: number; sha: string } | 'merged'> {
  const { exec } = k;
  const r = `/repos/${exec}`;
  const { data: main } = await k.gh.rest<{ object: { sha: string } }>('GET', `${r}/git/ref/heads/main`);
  await k.gh.rest('POST', `${r}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.object.sha });
  const head = await k.commitFiles(exec, branch, files, msg);
  const { data: pr } = await k.gh.rest<Pull>('POST', `${r}/pulls`, {
    title: msg,
    head: branch,
    base: 'main',
    body: '_An automated nibfin-e2e harness change._',
  });
  const test = await k.obs.until(
    `test on the harness PR #${pr.number}`,
    async () => {
      const t = (await k.obs.checkRuns(exec, head)).find((x) => x.name === 'test');
      return t?.status === 'completed' ? t : undefined;
    },
    DEADLINE.event,
    undefined,
    { noIssue: "it waits on the test check of the harness's own PR, which no hold of an Issue stops" },
  );
  if (test.conclusion !== 'success')
    throw new Error(`test on the harness PR #${pr.number} (${head}) concluded ${String(test.conclusion)}`);

  const { data: fixture } = await k.gh.rest<Pull>('GET', `${r}/pulls/${fixturePr}`);
  if (fixture.merged_at) {
    await k.gh.rest('PATCH', `${r}/pulls/${pr.number}`, { state: 'closed' });
    return 'merged';
  }
  const { data: repo } = await k.gh.rest<{
    allow_rebase_merge?: boolean;
    allow_squash_merge?: boolean;
    allow_merge_commit?: boolean;
  }>('GET', r);
  const method = mergeMethod(repo);
  if (!method) throw new Error(`${exec} allows no merge method`);
  let res = await k.gh.rest<{ message?: string }>(
    'PUT',
    `${r}/pulls/${pr.number}/merge`,
    { sha: head, merge_method: method },
    [405],
  );
  // A 405 can be GitHub still computing the merge; read the PR again on the next snapshot, three times at most.
  for (let i = 0; res.status === 405 && i < 3; i++) {
    await k.obs.fresh();
    const { data: again } = await k.gh.rest<Pull>('GET', `${r}/pulls/${pr.number}`);
    if (again.merged_at) break;
    res = await k.gh.rest<{ message?: string }>(
      'PUT',
      `${r}/pulls/${pr.number}/merge`,
      { sha: head, merge_method: method },
      [405],
    );
  }
  const { data: done } = await k.gh.rest<Pull>('GET', `${r}/pulls/${pr.number}`);
  if (!done.merged_at || !done.merge_commit_sha)
    throw new Error(
      `the harness PR #${pr.number} did not merge (${method}): ${res.status === 405 ? String(res.data.message) : 'merged_at is empty'}`,
    );
  const sha = done.merge_commit_sha;
  const [path, content] = Object.entries(files)[0] as [string, string];
  const onMain = await k.obs.descends(exec, sha, 'main');
  const got = await k.fileOn(exec, sha, path);
  if (!onMain || got !== content)
    throw new Error(
      `the harness PR #${pr.number} merged as ${sha}, but ${onMain ? '' : 'main does not contain it'}${!onMain && got !== content ? ' and ' : ''}${got !== content ? `${path} there is not the harness content` : ''}`,
    );
  await k.gh.rest('DELETE', `${r}/git/refs/heads/${branch}`, undefined, [404, 422]);
  return { at: time(done.merged_at), sha };
}

async function runHalf(
  k: Kit,
  c: Checks,
  spec: HalfSpec,
  filed: number[],
  harness: string[],
): Promise<string | undefined> {
  const { exec } = k;
  const label = `${spec.kind} half`;
  const owner = await k.owner();
  const src = `src/${spec.slug}.js`;
  const jsdoc = `/** ${spec.title} (fixture version). */`;
  await k.hookRules('ci', [{ when: `test/${spec.slug}.test.js`, event: 'pull_request', holdTag: `${spec.slug}-hold` }]);
  const extra = spec.kind === 'conflict' ? `The first line of \`${src}\` must be exactly \`${jsdoc}\`.` : '';
  const issue = await k.file(exec, {
    scenario: 'review-rebase',
    title: spec.title,
    body: changeRequest(spec.slug, spec.fn, spec.behaviour, extra),
    labels: ['scope'],
    assignees: [owner.login],
  });
  filed.push(issue.number);
  try {
    return await heldHalf(k, c, spec, issue.number, harness);
  } finally {
    // Lets a CI job still held finish whatever happened; a tag that exists already answers 422.
    try {
      await release(k, spec.slug);
    } catch (error) {
      k.ctx.log(`${label}: could not create tag ${spec.slug}-hold: ${message(error)}`);
    }
  }
}

/** Creates the hold tag at main's head, so the fixture's held CI finishes; an existing tag is fine. */
async function release(k: Kit, slug: string): Promise<void> {
  const { data: main } = await k.gh.rest<{ object: { sha: string } }>('GET', `/repos/${k.exec}/git/ref/heads/main`);
  await k.gh.rest('POST', `/repos/${k.exec}/git/refs`, { ref: `refs/tags/${slug}-hold`, sha: main.object.sha }, [422]);
}

/** The part of a half after its fixture is filed, while the fixture's PR CI is held. */
async function heldHalf(k: Kit, c: Checks, spec: HalfSpec, n: number, harness: string[]): Promise<string | undefined> {
  const { exec } = k;
  const label = `${spec.kind} half`;
  const src = `src/${spec.slug}.js`;
  const branch = `nibfin/issue-${n}`;
  const show = k.show(exec, n);
  const opened = await k.obs.until(
    `${label}: #${n}'s PR open with test held`,
    async (s) => {
      const prs = (s.pulls.get(exec) ?? []).filter((p) => p.head.ref === branch);
      if (prs.some((p) => p.merged_at)) return 'merged' as const;
      const pr = prs.find((p) => p.state === 'open');
      if (!pr) return undefined;
      const t = (await k.obs.checkRuns(exec, pr.head.sha)).find((x) => x.name === 'test');
      return t && t.status !== 'completed' ? pr : undefined;
    },
    DEADLINE.delivery,
    show,
    k.about(exec, n),
  );
  if (opened === 'merged') {
    c.notExercised(RULE, `${label}: #${n}'s PR merged before main advanced`);
    return undefined;
  }

  const advance = `e2e-advance-${spec.slug}`;
  harness.push(advance);
  let files: Record<string, string>;
  if (spec.kind === 'behind') {
    files = { [`docs/${spec.slug}-main.md`]: `A harness change on main that #${n} does not touch.\n` };
  } else {
    const theirs = await k.fileOn(exec, opened.head.sha, src);
    if (theirs === undefined) {
      c.notExercised(
        RULE,
        `${label}: #${n}'s PR #${opened.number} does not add ${src}, so main's add of it cannot conflict`,
      );
      return undefined;
    }
    files = { [src]: `/** ${spec.title} (main's version). */\nexport function ${spec.fn}(x) {\n  return -x;\n}\n` };
  }
  const moved = await advanceMain(k, advance, files, `Advance main for nibfin-e2e ${spec.slug}`, opened.number);
  if (moved === 'merged') {
    c.notExercised(RULE, `${label}: #${n}'s PR #${opened.number} merged before main advanced`);
    return undefined;
  }
  const state = await settledMergeable(
    () => k.gh.rest<Held>('GET', `/repos/${exec}/pulls/${opened.number}`).then((r) => r.data),
    { now: () => k.now(), sleep: k.sleep, signal: k.ctx.signal },
  );
  c.note(
    `${label}: PR #${opened.number} read mergeable ${String(state.mergeable)}/${String(state.state)} after main advanced (${state.reads} read${state.reads === 1 ? '' : 's'})${state.settled ? '' : `; it did not settle within ${SETTLE_MS / 1000} s`}${state.error ? `; last read error: ${state.error}` : ''}`,
  );
  await release(k, spec.slug);

  await k.obs.until(
    `${label}: #${n} to close with delivered`,
    (s) => k.delivered(s, exec, n),
    DEADLINE.delivery,
    show,
    k.about(exec, n),
  );
  const s = await k.obs.fresh();
  const merged = (await k.obs.pullsByHead(exec, branch)).find((p) => p.merged_at);
  const delivers: DeliverJob[] = [];
  for (const j of await k.agentJobs(s, exec, n, ['deliver'])) {
    let reason: string | undefined;
    if (time(j.started_at) >= moved.at && j.status === 'completed') {
      try {
        reason = reasonOf(await k.obs.log(exec, j.id));
      } catch (error) {
        reason = `unreadable: ${message(error)}`;
      }
    }
    delivers.push({ id: j.id, started_at: j.started_at, reason });
  }
  const evidence: RebaseEvidence = {
    issue: `${exec}#${n}`,
    branch,
    at: moved.at,
    sha: moved.sha,
    delivers,
    runs: k.stages(s, exec, n).map((r) => ({ id: r.id, stage: r.stage, created_at: r.created_at })),
    forced: await k.obs.activity(exec, { ref: `refs/heads/${branch}`, type: 'force_push' }),
    merged: merged ? { number: merged.number, head: merged.head.sha, merged_at: merged.merged_at } : undefined,
    descends: merged ? await k.obs.descends(exec, moved.sha, merged.head.sha) : false,
    delivered: !!k.delivered(s, exec, n),
  };
  const why = notExercisedWhy(spec.kind, evidence);
  if (why) {
    c.notExercised(RULE, `${label}: ${why}`);
    return undefined;
  }
  const problems = spec.kind === 'behind' ? behindProblems(evidence) : conflictProblems(evidence);
  c.none(
    RULE,
    problems.map((p) => `${label}: ${p}`),
  );
  if (spec.kind === 'behind') return `#${n} was behind only and merged PR #${merged?.number} without a Deliver`;
  const { first, runs } = conflictWindow(evidence);
  const reason = first?.reason ?? 'unknown';
  if (!problems.length)
    c.note(`${label}: deliver job ${first?.id} (REASON ${reason}) followed stage runs ${seenRuns(runs)}`);
  return `#${n} conflicted, was rebased by a Deliver (REASON ${reason}) and merged PR #${merged?.number}`;
}

export const reviewRebase: Scenario = lifecycle({
  id: 'review-rebase',
  concurrent: true,
  rules: [RULE],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    const filed: number[] = [];
    const harness: string[] = [];
    try {
      await k.baseline();
      const halves: HalfSpec[] = [
        {
          kind: 'behind',
          slug: k.slug('rb'),
          title: 'Add quadruple',
          fn: 'quadruple',
          behaviour: 'returns its argument times four',
        },
        {
          kind: 'conflict',
          slug: k.slug('rc'),
          title: 'Add negate',
          fn: 'negate',
          behaviour: 'returns its argument negated',
        },
      ];
      const results = await Promise.allSettled(halves.map((h) => runHalf(k, c, h, filed, harness)));
      const done: string[] = [];
      results.forEach((r, i) => {
        if (r.status === 'rejected') c.fail(RULE, `${halves[i]?.kind} half: ${message(r.reason)}`);
        else if (r.value) done.push(r.value);
      });
      return c.outcome(done.join('; '));
    } finally {
      await k.pauseOpen(exec, filed);
      for (const b of harness) {
        try {
          await k.gh.rest('DELETE', `/repos/${exec}/git/refs/heads/${b}`, undefined, [404, 422]);
        } catch (error) {
          k.ctx.log(`could not delete ${exec} branch ${b}: ${message(error)}`);
        }
      }
    }
  },
});
