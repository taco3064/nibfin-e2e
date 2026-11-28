// Shared deliveries: one set of fixtures, driven once, that several scenarios assert on.
// A journey performs every harness write its scenarios need and records the moments
// they check; the scenarios then read GitHub to judge them.
import { AGENT_STAGES, selfHosted, time, wakeRuns } from './analysis.ts';
import type { Issue, Job, Pull, Run, Stage } from './analysis.ts';
import { DEADLINE, changeRequest, message, redact } from './kit.ts';
import type { Kit } from './kit.ts';
import type { Expects, Snapshot } from './observe.ts';
import { sleep } from '../lib/wait.ts';
import { untilAborted } from '../../src/abort.ts';

type Gone = (s: Snapshot) => Promise<string | undefined>;

/** A `gonePast` check giving the first reason any of `checks` gives. */
const firstOf =
  (...checks: Gone[]): Gone =>
    async (s) => {
      for (const c of checks) {
        const reason = await c(s);
        if (reason !== undefined) return reason;
      }
      return undefined;
    };

/** How often `stageJobRunning` reads a stage run's jobs directly. */
export const DIRECT_READ_MS = 10_000;
/** How long `stageJobRunning` reads directly on one snapshot before it lets the observer read the next one (its default interval). */
const DIRECT_SPAN_MS = 60_000;

/** How the shared wait of `stageJobRunning` ended through its `gonePast`, when it did. */
type JobWaitExit = 'missed' | 'hard' | 'followed';

/**
 * Waits for a self-hosted job of an Issue's `stage` to be `in_progress`, reading the
 * jobs of the Issue's unfinished runs of that stage directly every `DIRECT_READ_MS`
 * rather than through the observer's snapshot and its cached job reads, which may miss a
 * short job (Issue #544). The wait fails at once when such a job completed before any
 * read saw it running, and otherwise ends on a hold of the Issue (`Kit.heldReason`), on
 * `stageGone`, the stall limit or the deadline.
 * Every reason from those also names what the direct reads saw: each run read, the
 * stage's job in its last read (or that no read saw a run of the stage), and the last
 * direct read error, if any.
 *
 * `since` is passed to `stageGone` (its default applies when absent). `whileRunning` is a
 * further condition checked on each direct read that sees the job `in_progress`: the job
 * is returned only when the condition holds, and is read again with it every
 * `DIRECT_READ_MS` while it does not. If the job then completes before a read saw the
 * condition hold, the wait fails at once with the job's times and the condition's last
 * read (Issue #581).
 */
export async function stageJobRunning(k: Kit, n: number, stage: Stage, o: StageJobOptions): Promise<StageJob> {
  return waitStageJob(k, n, stage, o).wait;
}

/**
 * `stageJobRunning`, except that a wait ending because the job can no longer be seen
 * running gives `{ missed }` with the full reason instead of failing: the job completed
 * before any read saw it running, or a job of the stage completed and a run of another
 * agent stage followed. Every other end (the Issue closed, `pending`, the deadline, the
 * stall limit, an abort) still fails.
 */
export async function stageJobRunningOrMissed(
  k: Kit,
  n: number,
  stage: Stage,
  o: StageJobOptions,
): Promise<StageJob | { missed: string }> {
  const w = waitStageJob(k, n, stage, o);
  try {
    return await w.wait;
  } catch (e) {
    const exit = w.exit();
    if (exit === 'missed' || exit === 'followed') return { missed: message(e) };
    throw e;
  }
}

type StageJob = Job & { stage: Stage; run: Run };

interface StageJobOptions {
  desc: string;
  deadlineMs: number;
  show?: (s: Snapshot) => Promise<string>;
  /** The Issue's name in the reason (default `P`). */ who?: string;
  /** Only the stage's jobs created at or after this epoch ms count for `stageGone`. */ since?: number;
  /** The holds of the Issue this wait expects, each with why (see `Kit.heldReason`). */ expects?: Expects;
  whileRunning?: {
    /** What the wait still needs, as it reads after "before" in the reason. */
    what: string;
    /** Whether the condition holds now; `last` describes the read that found it unmet. */
    check: (j: StageJob) => Promise<{ ok: true } | { ok: false; last: string }>;
  };
}

function waitStageJob(
  k: Kit,
  n: number,
  stage: Stage,
  o: StageJobOptions,
): { wait: Promise<StageJob>; exit: () => JobWaitExit | undefined } {
  const pause = k.sleep ?? sleep;
  const iso = (t: number) => new Date(t).toISOString();
  // A re-run keeps the run id, so a run and its attempt name one execution.
  const key = (run: Run) => `${run.id}/${run.run_attempt ?? 1}`;
  /** Run attempts that completed without running an agent job (cancelled or skipped). */
  const finished = new Set<string>();
  /** The previous direct read of each job: when, and its status then. */
  const lastRead = new Map<number, { at: number; status: string }>();
  /** Jobs seen running while `whileRunning` did not hold, with the condition's last read. */
  const unmet = new Map<number, string>();
  /** The last successful direct read of each run attempt, with the self-hosted job it found. */
  const reads = new Map<string, { at: number; runId: number; attempt: number; job?: Job }>();
  let readError: { at: number; runId: number; message: string } | undefined;
  let missed: { reason: string; run: string } | undefined;
  let exit: JobWaitExit | undefined;
  const readOf = (r: { at: number; runId: number; attempt: number; job?: Job }) => {
    const head = `run ${r.runId} (attempt ${r.attempt}) last read at ${iso(r.at)}`;
    if (!r.job) return `${head}: no self-hosted job`;
    const j = r.job;
    const status = `${j.status}${j.status === 'completed' ? ` (${String(j.conclusion)})` : ''}`;
    return `${head}: job ${j.id} ${status}, started ${j.started_at ?? 'none'}, completed ${j.completed_at ?? 'none'}`;
  };
  const errorSuffix = () =>
    readError ? `; last direct read error at ${iso(readError.at)} (run ${readError.runId}): ${readError.message}` : '';
  /** What the direct reads saw, for a reason that does not come from them. */
  const summary = () => {
    const runs = [...reads.values()].map(readOf).join(', ');
    return `direct reads: ${runs || `none saw a ${stage} run of #${n}`}${errorSuffix()}`;
  };
  /** The missed reason, with the other runs read and the last read error when there are any. */
  const missedReason = (m: { reason: string; run: string }) => {
    const others = [...reads.entries()].filter(([id]) => id !== m.run).map(([, r]) => readOf(r));
    return `${m.reason}${others.length ? `; other direct reads: ${others.join(', ')}` : ''}${errorSuffix()}`;
  };
  const list = async (run: Run) => {
    const at = k.now();
    try {
      return { at, jobs: await k.gh.list<Job>(`/repos/${k.exec}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs') };
    } catch (e) {
      // The observer logs the error and names it when the wait ends; it is kept here for the reason too.
      if (!k.ctx.signal?.aborted) readError = { at, runId: run.id, message: message(e) };
      throw e;
    }
  };
  const read = async (run: Run & { stage: Stage }): Promise<StageJob | undefined> => {
    const { at, jobs } = await list(run);
    const own = jobs.filter(selfHosted);
    const live = own.find((j) => j.status === 'in_progress');
    const done = own.find(
      (j) => j.status === 'completed' && j.conclusion !== 'cancelled' && j.conclusion !== 'skipped',
    );
    reads.set(key(run), { at, runId: run.id, attempt: run.run_attempt ?? 1, job: live ?? done ?? own[0] });
    if (live) {
      const j = { ...live, stage, run };
      if (!o.whileRunning) return j;
      const r = await o.whileRunning.check(j);
      if (r.ok) return j;
      unmet.set(live.id, r.last);
      return undefined;
    }
    if (done) {
      const head = `${o.who ?? 'P'}'s ${stage} job ${done.id} (run ${run.id}) completed (${String(done.conclusion)})`;
      const times = `started ${String(done.started_at)}, completed ${String(done.completed_at)}`;
      const last = unmet.get(done.id);
      if (o.whileRunning && last !== undefined) {
        missed = { reason: `${head} after the wait saw it running, before ${o.whileRunning.what}: ${times}; ${last}`, run: key(run) };
        return undefined;
      }
      const prev = lastRead.get(done.id);
      const seen = prev
        ? `the wait last read it at ${iso(prev.at)} (${prev.status})`
        : `on its first read at ${iso(at)}`;
      missed = { reason: `${head} before the wait saw it running: ${times}; ${seen}`, run: key(run) };
      return undefined;
    }
    for (const j of own) lastRead.set(j.id, { at, status: j.status });
    if (run.status === 'completed' && jobs.every((j) => j.status === 'completed')) finished.add(key(run));
    return undefined;
  };
  const fn = async (s: Snapshot) => {
    const until = k.now() + DIRECT_SPAN_MS;
    for (;;) {
      if (missed !== undefined) return undefined;
      const runs = k.stages(s, k.exec, n, [stage]).filter((r) => !finished.has(key(r)));
      if (!runs.length) return undefined;
      for (const run of runs) {
        const j = await read(run);
        if (j || missed !== undefined) return j;
      }
      if (k.now() + DIRECT_READ_MS > until) return undefined;
      await untilAborted(pause(DIRECT_READ_MS), k.ctx.signal);
    }
  };
  // The holds (closed, `pending`, `pause`) are judged apart from the job exit, so a caller can
  // tell them apart, and here rather than by the observer, so their reason names what the direct reads saw.
  const hard: Gone = (s) => k.heldReason(s, k.exec, n, o.expects ?? {});
  const followed = k.stageGone(k.exec, n, stage, { since: o.since });
  const redacted = (reason: string) => redact(reason, k.ctx.secretValues());
  const gonePast: Gone = async (s) => {
    if (missed !== undefined) {
      exit = 'missed';
      return redacted(missedReason(missed));
    }
    for (const [kind, check] of [
      ['hard', hard],
      ['followed', followed],
    ] as const) {
      const reason = await check(s);
      if (reason !== undefined) {
        exit = kind;
        return redacted(`${reason}; ${summary()}`);
      }
    }
    return undefined;
  };
  return {
    wait: k.obs.until(o.desc, fn, o.deadlineMs, o.show, {
      gonePast,
      issues: [{ repo: k.exec, n }],
      expects: o.expects,
    }),
    exit: () => exit,
  };
}

export interface Journey {
  a: Issue;
  x: Issue;
  b: Issue;
  c: Issue;
  u: Issue;
  slugA: string;
  startedAt: number;
  endedAt: number;
  /** After A's `opened` wake run completed (before `scope`): A's stage runs and comments. */
  aBeforeScope: { stageRuns: number; comments: number };
  aScopedAt: number;
  /**
   * The Deliver job of A during which `e2e-wake` was toggled twice, with when; or, when no
   * read saw that job running (it completed first, or completed and a later agent stage
   * followed), why no wakes were sent.
   */
  wakeToggles: { jobId: number; at: number[] } | { missed: string };
  aPr: Pull;
  mergeSha: string;
  /** A was open after CI attempt 1 completed while CD was held. */
  openWhileCdHeld: boolean;
  /** A was open after CD completed and the runs it woke completed, while the CI re-run was held. */
  openAfterCd: boolean;
  ciRun: Run;
  cdRun: Run;
  /** When the harness last wrote to B and C (the `scope` label). */
  lastWrite: { b: number; c: number };
}

const isOpen = (k: Kit, s: Snapshot, n: number) => k.issue(s, k.exec, n)?.state === 'open';

/** A (full lifecycle), X (parallel, codex asked in text), B ← A and C ← B (native chain), U (no Assignee). */
export function journey(k: Kit): Promise<Journey> {
  const filed: number[] = [];
  return k.once('journey', () => driveJourney(k, filed).finally(() => k.pauseOpen(k.exec, filed)));
}

async function driveJourney(k: Kit, filed: number[]): Promise<Journey> {
  await k.baseline();
  const startedAt = k.now();
  const { exec } = k;
  const owner = await k.owner();
  const slugA = k.slug('a');
  const t = k.tag;
  await k.hookRules('cd', [{ when: `src/${slugA}.js`, event: 'push', holdTag: `${t}-a-cd` }]);
  await k.hookRules('ci', [{ when: `src/${slugA}.js`, event: 'push', attempt: 2, holdTag: `${t}-a-ci2` }]);

  const a = await k.file(exec, {
    scenario: 'delivery-lifecycle',
    title: 'Add triple',
    body: changeRequest(slugA, 'triple', 'returns its argument times three'),
    assignees: [owner.login],
  });
  const b = await k.file(exec, {
    scenario: 'delivery-blocked-by-chain',
    title: 'Add double',
    body: changeRequest(k.slug('b'), 'double', 'returns its argument times two'),
    assignees: [owner.login],
  });
  const c = await k.file(exec, {
    scenario: 'delivery-blocked-by-chain',
    title: 'Add negate',
    body: changeRequest(k.slug('c'), 'negate', 'returns its argument negated'),
    assignees: [owner.login],
  });
  await k.blockBy(exec, b.number, [a]);
  await k.blockBy(exec, c.number, [b]);
  await k.addLabels(exec, b.number, ['scope']);
  const lastB = k.now();
  await k.addLabels(exec, c.number, ['scope']);
  const lastC = k.now();
  const x = await k.file(exec, {
    scenario: 'delivery-parallel',
    title: 'Add square',
    body: changeRequest(
      k.slug('x'),
      'square',
      'returns its argument squared',
      `Please deliver this with the codex provider.\n\nBlocked by #${c.number}`,
    ),
    labels: ['scope'],
    assignees: [owner.login],
  });
  const u = await k.file(exec, {
    scenario: 'delivery-blocked-by-chain',
    title: 'Add halve',
    body: changeRequest(k.slug('u'), 'halve', 'returns half its argument'),
    labels: ['scope'],
  });
  filed.push(a.number, b.number, c.number, x.number, u.number);

  // R4.7: A without `scope` gets no stage and no comment once its opened wake completed.
  await k.obs.until(
    "A's opened wake run to complete",
    (s) => (wakeRuns(s.runs, exec, a.number).some((r) => r.status === 'completed') ? true : undefined),
    DEADLINE.event,
    k.show(exec, a.number),
    k.about(exec, a.number),
  );
  const calm = await k.settle('A opened', k.now(), k.runsOf(exec, a.number));
  // Route may run for any Issue event; only an agent stage would mean A was taken up.
  const aBeforeScope = {
    stageRuns: k.stages(calm, exec, a.number, AGENT_STAGES).length,
    comments: (await k.obs.comments(exec, a.number)).length,
  };
  await k.addLabels(exec, a.number, ['scope']);
  const aScopedAt = k.now();

  // R4.35: two wakes while A's Deliver runs.
  // A's deliver jobs are read directly: a short Deliver can run between two snapshots (Issue #567).
  // A job no read saw running leaves R4.35 unexercised; the journey's other checks still need the rest.
  const deliverJob = await stageJobRunningOrMissed(k, a.number, 'deliver', {
    desc: "A's deliver job to run",
    deadlineMs: DEADLINE.delivery,
    show: k.show(exec, a.number),
    who: 'A',
  });
  let wakeToggles: Journey['wakeToggles'];
  if ('missed' in deliverJob) {
    k.ctx.log(`journey: no wakes sent during A's Deliver: ${deliverJob.missed}`);
    wakeToggles = { missed: deliverJob.missed };
  } else {
    const toggles: number[] = [];
    for (let i = 0; i < 2; i++) {
      toggles.push(k.now());
      await k.addLabels(exec, a.number, ['e2e-wake']);
      await k.removeLabel(exec, a.number, 'e2e-wake');
    }
    wakeToggles = { jobId: deliverJob.id, at: toggles };
  }

  const branch = `nibfin/issue-${a.number}`;
  const aPr = await k.obs.until(
    "A's PR to merge",
    (s) => s.pulls.get(exec)?.find((p) => p.head.ref === branch && p.merged_at),
    DEADLINE.delivery,
    k.show(exec, a.number),
    k.about(exec, a.number),
  );
  const { data: main } = await k.gh.rest<{ commit: { sha: string } }>('GET', `/repos/${exec}/branches/main`);
  const mergeSha = aPr.merge_commit_sha ?? main.commit.sha;
  const pushRun = (s: Snapshot, name: string) =>
    s.runs.find((r) => r.repo === exec && r.name === name && r.event === 'push' && r.head_sha === mergeSha);

  // R3.31, R3.34: CI attempt 1 completes while CD is held; A stays open.
  const ciRun = await k.obs.until(
    "CI attempt 1 of A's merge to complete",
    (s) => {
      const r = pushRun(s, 'CI');
      return r && r.status === 'completed' && (r.run_attempt ?? 1) === 1 ? r : undefined;
    },
    DEADLINE.event,
    undefined,
    { noIssue: "it waits on the merge commit's CI run, which no hold of A stops; A staying open is judged after" },
  );
  // What a CI or CD completion of the merge wakes: A's own runs and Nibfin's runs for the merge commit.
  const ofA = k.runsOf(exec, a.number);
  const forMerge = (r: Run) =>
    r.display_title.startsWith('Nibfin ·') && r.display_title.includes(`@${mergeSha.slice(0, 7)}`);
  const heldCd = (r: Run) => r.name === 'CD' && r.head_sha === mergeSha;
  const afterCi = await k.settle(
    "CI of A's merge",
    time(ciRun.updated_at),
    (r) => (ofA(r) || forMerge(r)) && !heldCd(r),
  );
  const openWhileCdHeld = isOpen(k, afterCi, a.number) && pushRun(afterCi, 'CD')?.status !== 'completed';

  // R3.36: a re-run attempt of CI that starts before CD completes, still running when it does.
  await k.gh.rest('POST', `/repos/${exec}/actions/runs/${ciRun.id}/rerun`);
  // Read the run itself: a re-run keeps its created_at, which may be older than the observer's listing window.
  await k.obs.until(
    'the CI re-run to start',
    async () => {
      const { data: r } = await k.gh.rest<Run>('GET', `/repos/${exec}/actions/runs/${ciRun.id}`);
      return (r.run_attempt ?? 1) >= 2 && r.status !== 'completed' ? r : undefined;
    },
    DEADLINE.event,
    undefined,
    { noIssue: 'it waits on the re-run the harness started, which no hold of A stops' },
  );
  await k.gh.rest('POST', `/repos/${exec}/git/refs`, { ref: `refs/tags/${t}-a-cd`, sha: mergeSha });
  const cdRun = await k.obs.until(
    "CD of A's merge to complete",
    (s) => {
      const r = pushRun(s, 'CD');
      return r?.status === 'completed' ? r : undefined;
    },
    DEADLINE.event,
    undefined,
    { noIssue: "it waits on the merge commit's CD run, which no hold of A stops; A staying open is judged after" },
  );
  const heldCi = (r: Run) => r.name === 'CI' && r.head_sha === mergeSha;
  const afterCd = await k.settle(
    "CD of A's merge",
    time(cdRun.updated_at),
    (r) => (ofA(r) || forMerge(r)) && !heldCi(r),
  );
  const openAfterCd = isOpen(k, afterCd, a.number);
  await k.gh.rest('POST', `/repos/${exec}/git/refs`, { ref: `refs/tags/${t}-a-ci2`, sha: mergeSha });

  await k.obs.until(
    'A to close with delivered',
    (s) => k.delivered(s, exec, a.number),
    DEADLINE.delivery,
    k.show(exec, a.number),
    { ...k.about(exec, a.number), gonePast: k.closeGone(exec, a.number) },
  );
  for (const [name, n] of [
    ['B', b.number],
    ['C', c.number],
    ['X', x.number],
  ] as const) {
    await k.obs.until(
      `${name} to close with delivered`,
      (s) => k.delivered(s, exec, n),
      DEADLINE.delivery,
      k.show(exec, n),
      { ...k.about(exec, n), gonePast: k.closeGone(exec, n) },
    );
  }
  return {
    a,
    x,
    b,
    c,
    u,
    slugA,
    startedAt,
    endedAt: k.now(),
    aBeforeScope,
    aScopedAt,
    wakeToggles,
    aPr,
    mergeSha,
    openWhileCdHeld,
    openAfterCd,
    ciRun,
    cdRun,
    lastWrite: { b: lastB, c: lastC },
  };
}

export interface HoldJourney {
  p: Issue;
  pausedAt: number;
  /** Why the pause did not land while Shape ran, if so. */
  pauseLate?: string;
  /** Deliver runs of P created while `pause` was on, once P's runs settled after its Shape was published. */
  deliverWhilePaused: number;
  editedAt: number;
  /** Deliver removed `shaped` after the edit (sent the Shape back). */
  sentBack: boolean;
  reshapedAt?: number;
  pendingAt: number;
  /** Review runs of P created while `pending` was on, after the PR's `test` completed and the woken runs completed. */
  reviewWhilePending: number;
  /** Why the pending hold could not be observed (it came after PR CI completed or a review started), if so. */
  pendingLate?: string;
  unpendedAt: number;
}

const hasLabel = (k: Kit, s: Snapshot, n: number, l: string) => k.labels(s, k.exec, n).includes(l);
/** Why the hold journey's waits that run while its own `pending` is on do not end on it. */
const OWN_PENDING = 'the hold journey added pending itself and waits on what P does while it is on';

export type PauseOutcome = { kind: 'published' } | { kind: 'fault'; reason: string };

/**
 * How the Shape running when `pause` was added ended, from P's state once its runs
 * settled with `pause` still on. Proposal R4.12 says `pause` is no immediate stop: the
 * running Shape finishes, publishing included, and only then is P held. So `published`
 * (`shaped` on while `pause` is on) is the only pass, and anything else is a fault. A
 * Shape that ended unpublished is reported as stopped early, or as R4.12 not exercised
 * when `late` says its job had already completed before `pause` was added.
 */
export function pauseOutcome(i: {
  open: boolean;
  labels: string[];
  shapedAddedWhilePaused: boolean;
  /** The shape job that was running when `pause` was added, as it completed. */
  shapeJob: Pick<Job, 'id' | 'conclusion' | 'started_at' | 'completed_at'>;
  /** Why `pause` did not land while that job ran, if so. */
  late?: string;
}): PauseOutcome {
  if (!i.open) return { kind: 'fault', reason: 'P closed while pause was on' };
  if (i.labels.includes('pending')) return { kind: 'fault', reason: 'P got pending while pause was on' };
  if (i.labels.includes('shaped')) return { kind: 'published' };
  if (i.shapedAddedWhilePaused) return { kind: 'fault', reason: '`shaped` was added and removed while pause was on' };
  if (i.late !== undefined) return { kind: 'fault', reason: `R4.12: not exercised: ${i.late}, and its Shape was not published` };
  const j = i.shapeJob;
  return {
    kind: 'fault',
    reason: `R4.12: the running Shape stopped before publishing: P's shape job ${j.id} completed (${String(j.conclusion)}) without \`shaped\` while pause was on (started ${String(j.started_at)}, completed ${String(j.completed_at)})`,
  };
}

export type PendingOutcome = { kind: 'sent back' } | { kind: 'pr' } | { kind: 'fault'; reason: string };

/**
 * How the Deliver of P running when `pending` was added has ended, judged from one
 * snapshot, or `undefined` while it can still end either way. Proposal R4.13 says the
 * running Deliver finishes, opening its PR, before `pending` holds P, so a Deliver that
 * succeeded without a PR is a fault: it stopped before opening its PR, or R4.13 was not
 * exercised when the job completed at or before `pendingAt`. That fault needs the job's
 * whole run completed in the same snapshot: a snapshot lists pulls after runs, so a PR
 * that run opened would then be in `pr`. Faults are states the wait can no longer leave
 * while `pending` is on.
 */
export function pendingOutcome(i: {
  /** Whether Deliver may send the Shape back (the first Deliver after the edit). */
  sendBackExpected: boolean;
  /** Whether the snapshot shows the Shape sent back (`shaped` removed after the edit). */
  sentBack: boolean;
  /** Whether an open PR for `nibfin/issue-<n>` exists. */
  pr: boolean;
  open: boolean;
  shaped: boolean;
  job: Pick<Job, 'id' | 'status' | 'conclusion' | 'started_at' | 'completed_at'>;
  /** Whether the job's run is completed in the same snapshot. */
  runCompleted: boolean;
  /** When `pending` was added (epoch ms). */
  pendingAt: number;
}): PendingOutcome | undefined {
  if (i.sendBackExpected && i.sentBack) return { kind: 'sent back' };
  if (i.pr) return { kind: 'pr' };
  if (!i.open) return { kind: 'fault', reason: 'P closed while pending was on' };
  if (!i.shaped && !i.sendBackExpected)
    return { kind: 'fault', reason: 'P lost shaped while pending was on, with no send-back expected' };
  const { job } = i;
  if (job.status !== 'completed') return undefined;
  const times = `started ${String(job.started_at)}, completed ${String(job.completed_at)}`;
  if (job.conclusion !== 'success')
    return {
      kind: 'fault',
      reason: `P's deliver job ${job.id} completed with ${String(job.conclusion)} while pending was on (${times})`,
    };
  if (!i.runCompleted || !i.shaped) return undefined;
  if (time(job.completed_at) <= i.pendingAt)
    return {
      kind: 'fault',
      reason: `R4.13: not exercised: P's deliver job ${job.id} completed before pending was added, without a PR`,
    };
  return {
    kind: 'fault',
    reason: `R4.13: the running Deliver stopped before opening its PR: P's deliver job ${job.id} succeeded without a PR while pending was on (${times})`,
  };
}

/** The first PR for P's branch `nibfin/issue-<n>` among `pulls`, only an open one when `open`. */
export function branchPr(pulls: readonly Pull[] | undefined, n: number, open: boolean): Pull | undefined {
  return pulls?.find((pr) => pr.head.ref === `nibfin/issue-${n}` && (!open || pr.state === 'open'));
}

const prState = (pr: Pick<Pull, 'state' | 'merged_at'>) =>
  pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'closed';

/**
 * Why the wait for the `test` check of P's PR can no longer succeed, judged from one
 * snapshot, or `undefined` while it still can. It ends when the PR the wait saw open was
 * closed or merged before its `test` completed, or when P has no open PR, every deliver
 * run of P since the wait began has completed and a `pending` the repair stage is not
 * clearing stays on: while `pending` is on no Deliver is dispatched (Proposal R4.13), so
 * none can open the PR.
 */
export function prTestFault(i: {
  n: number;
  /** The open PR, else the PR this wait last saw open as it is now, else undefined. */
  pr: Pick<Pull, 'number' | 'state' | 'merged_at'> | undefined;
  /** Whether that PR's `test` check on its head is completed. */
  testCompleted: boolean;
  /** P's deliver runs created since the wait began. */
  deliverRuns: readonly { status: string }[];
  /** Whether P is open and has `pending` in this snapshot. */
  pendingOn: boolean;
  /** Why the `pending` on P ends a stage wait (`stageGone`'s text), undefined while the repair stage may clear it. */
  pendingReason?: string;
}): string | undefined {
  const { pr } = i;
  if (pr?.state === 'open') return undefined;
  if (pr && !i.testCompleted) return `P's PR #${pr.number} was ${prState(pr)} before its test check completed`;
  if (i.pendingOn && i.pendingReason !== undefined && i.deliverRuns.every((r) => r.status === 'completed'))
    return `P has no open PR for nibfin/issue-${i.n}, its Deliver completed and pending is still on, so no Deliver can open one (Proposal R4.13): ${i.pendingReason}`;
  return undefined;
}

/**
 * One line naming the PR a wait on P's PR `test` check judges: its number, state, head and
 * that check (`undefined` when the head has none, `{ error }` when the read failed), or
 * that the branch has no PR at all.
 */
export function prTestState(
  n: number,
  pr: Pick<Pull, 'number' | 'state' | 'merged_at' | 'head'> | undefined,
  test: { status: string; conclusion: string | null } | { error: string } | undefined,
): string {
  if (!pr) return `no PR for nibfin/issue-${n}`;
  const check =
    test === undefined
      ? 'no test check on that head'
      : 'error' in test
        ? `test check unread (${test.error})`
        : `test ${test.status}/${test.conclusion ?? 'none'}`;
  return `PR #${pr.number} ${prState(pr)}, head ${pr.head.sha}: ${check}`;
}

/** P: `pause` at a stage boundary, an edit that contradicts its Shape, then `pending` during Deliver. */
export function holdJourney(k: Kit): Promise<HoldJourney> {
  const filed: number[] = [];
  return k.once('hold', () => driveHold(k, filed).finally(() => k.pauseOpen(k.exec, filed)));
}

async function driveHold(k: Kit, filed: number[]): Promise<HoldJourney> {
  await k.baseline();
  const { exec } = k;
  const owner = await k.owner();
  const slug = k.slug('p');
  const p = await k.file(exec, {
    scenario: 'pause-and-pending',
    title: 'Add triple',
    body: changeRequest(slug, 'triple', 'returns its argument times three'),
    labels: ['scope'],
    assignees: [owner.login],
  });
  const n = p.number;
  filed.push(n);
  const show = k.show(exec, n);
  const running =
    (stage: 'shape' | 'deliver', after = 0) =>
      async (s: Snapshot) =>
        (await k.agentJobs(s, exec, n, [stage])).find(
          (j: Job) => j.status === 'in_progress' && selfHosted(j) && time(j.started_at) >= after,
        );

  const shapeJob = await stageJobRunning(k, n, 'shape', {
    desc: "P's shape job to run",
    deadlineMs: DEADLINE.stage,
    show,
  });
  await k.addLabels(exec, n, ['pause']);
  const pausedAt = k.now();
  const shapeDone = await k.obs.until(
    "P's shape job to complete",
    async () => {
      const j = await k.obs.job(exec, shapeJob.id);
      return j.status === 'completed' ? j : undefined;
    },
    DEADLINE.stage,
    show,
    // The harness's own `pause` is on; the hold check exempts it.
    k.about(exec, n),
  );
  const pauseLate =
    time(shapeDone.completed_at) <= pausedAt
      ? `P's shape job ${shapeDone.id} completed before pause was added`
      : undefined;
  // With `pause` on, the running Shape must still be published, and only then is P held
  // (Proposal R4.12). Settle P's runs woken after `pause` (for example by `shaped` being
  // added) and judge it from P's state while still paused.
  const ofP = k.runsOf(exec, n);
  const calm = await k.settle('P paused', pausedAt, ofP);
  const pi = k.issue(calm, exec, n);
  const decided = pauseOutcome({
    open: pi?.state === 'open',
    labels: k.labels(calm, exec, n),
    shapedAddedWhilePaused: (await k.labeledAt(exec, n, 'shaped', time(shapeJob.started_at))) !== undefined,
    shapeJob: shapeDone,
    late: pauseLate,
  });
  if (decided.kind === 'fault') throw new Error(`${decided.reason}: ${await k.summary(calm, exec, n)}`);
  const deliverWhilePaused = k.stages(calm, exec, n, ['deliver']).length;
  const edit = async () => {
    await k.gh.rest('PATCH', `/repos/${exec}/issues/${n}`, {
      body: changeRequest(
        slug,
        'quadruple',
        'returns its argument times four',
        'This replaces the earlier `triple` request: there must be no `triple` function.',
      ),
    });
    return k.now();
  };

  const editedAt = await edit();
  await k.removeLabel(exec, n, 'pause');
  const outcome = (s: Snapshot) => {
    if (!hasLabel(k, s, n, 'shaped')) return 'sent back' as const;
    if (s.pulls.get(exec)?.some((pr) => pr.head.ref === `nibfin/issue-${n}`)) return 'pr' as const;
    return undefined;
  };
  // Put `pending` on while the first Deliver after the edit runs, before it can open a
  // PR whose CI would wake a review. If that Deliver sends the Shape back instead,
  // `pending` comes off for the re-Shape and goes on again during the next Deliver.
  const first = await k.obs.until(
    "P's first Deliver after the edit",
    async (s) => {
      const o = outcome(s);
      if (o) return o;
      const job = await running('deliver', editedAt)(s);
      return job ? { kind: 'running' as const, job } : undefined;
    },
    DEADLINE.stage,
    show,
    {
      ...k.about(exec, n),
      gonePast: k.stageGone(exec, n, 'deliver', { since: editedAt - 60_000, allowPending: true }),
    },
  );
  const prOf = (s: Snapshot, open = false) => branchPr(s.pulls.get(exec), n, open);
  /**
   * Waits, with `pending` on, for the Deliver whose `job` was running when it was added to
   * send the Shape back (only when `sendBackExpected`) or open a PR (Proposal R4.13: the
   * running Deliver finishes before `pending` holds P). A state it can no longer leave,
   * such as that Deliver completing without a PR, ends the wait at once through
   * `gonePast` with `pendingOutcome`'s reason, because `until` takes an error thrown in
   * `fn` for a failed read. Deliver jobs created before `since`, such as one that already
   * sent the Shape back, are not judged.
   */
  const pendingWait = async (
    job: Job & { run: Run },
    sendBackExpected: boolean,
    pendingAt: number,
    since: number,
    desc: string,
  ) => {
    let fault: string | undefined;
    return k.obs.until(
      desc,
      async (s) => {
        const shaped = hasLabel(k, s, n, 'shaped');
        const o = pendingOutcome({
          sendBackExpected,
          sentBack: sendBackExpected && !shaped,
          pr: prOf(s, true) !== undefined,
          open: isOpen(k, s, n),
          shaped,
          job: await k.obs.job(exec, job.id),
          runCompleted: s.runs.some((r) => r.repo === exec && r.id === job.run.id && r.status === 'completed'),
          pendingAt,
        });
        if (o?.kind === 'fault') {
          fault = redact(`${o.reason}: ${await k.summary(s, exec, n)}`, k.ctx.secretValues());
          return undefined;
        }
        return o;
      },
      DEADLINE.stage,
      show,
      {
        ...k.about(exec, n),
        expects: { pending: OWN_PENDING },
        gonePast: firstOf(
          async () => fault,
          k.stageGone(exec, n, 'deliver', { since, allowPending: true }),
        ),
      },
    );
  };
  let pendingAt: number | undefined;
  let firstEnd: 'sent back' | 'pr';
  if (typeof first === 'object') {
    await k.addLabels(exec, n, ['pending']);
    pendingAt = k.now();
    firstEnd = (await pendingWait(first.job, true, pendingAt, editedAt - 60_000, 'Deliver to send the Shape back or open a PR')).kind;
  } else firstEnd = first;
  const sentBack = firstEnd === 'sent back';
  let reshapedAt: number | undefined;
  if (sentBack) {
    if (pendingAt !== undefined) await k.removeLabel(exec, n, 'pending');
    await k.obs.until(
      'P to be shaped again',
      (x) => (hasLabel(k, x, n, 'shaped') ? x : undefined),
      DEADLINE.stage,
      show,
      k.about(exec, n),
    );
    // The label's own time, not the snapshot's: a Deliver may start before the next snapshot.
    reshapedAt = await k.labeledAt(exec, n, 'shaped', editedAt);
    if (reshapedAt === undefined)
      throw new Error(`#${n} shows \`shaped\` again but its timeline has no labeled event after the edit`);
    const job2 = await k.obs.until(
      "P's next deliver job to run",
      running('deliver', reshapedAt),
      DEADLINE.stage,
      show,
      { ...k.about(exec, n), gonePast: k.stageGone(exec, n, 'deliver', { since: reshapedAt - 60_000 }) },
    );
    await k.addLabels(exec, n, ['pending']);
    pendingAt = k.now();
    // No send-back is expected here, so the wait ends only on P's PR.
    await pendingWait(job2, false, pendingAt, reshapedAt - 60_000, "P's next Deliver to open a PR");
  } else if (pendingAt === undefined) {
    // The PR was already open when first seen; the late-pending check below reports it.
    await k.addLabels(exec, n, ['pending']);
    pendingAt = k.now();
  }
  const pendAt = pendingAt;

  /**
   * Waits for the `test` check of P's open PR to complete. It ends at once on `gone`, then
   * when it can no longer succeed (`prTestFault`), judging only P's deliver runs created at
   * or after `since`. Every failure names the PR, its head and `test` check, before P's
   * summary. `expects` are the holds of P the wait expects.
   */
  const prTest = (gone: Gone, expects: Expects, since: number) => {
    // The PR this wait saw open: once it is closed, a snapshot alone cannot tell it from an older closed PR.
    let seen: number | undefined;
    const judged = (s: Snapshot) => {
      const open = prOf(s, true);
      if (open) seen = open.number;
      return open ?? (seen === undefined ? undefined : s.pulls.get(exec)?.find((pr) => pr.number === seen));
    };
    const testOf = async (pr: Pull) => (await k.obs.checkRuns(exec, pr.head.sha)).find((c) => c.name === 'test');
    const own: Gone = async (s) => {
      const pr = judged(s);
      const test = pr ? await testOf(pr) : undefined;
      const pendingOn = isOpen(k, s, n) && hasLabel(k, s, n, 'pending');
      // P is open here, so `stageGone` can only give the text of a `pending` the repair stage is not clearing.
      const pendingReason =
        pr?.state !== 'open' && pendingOn ? await k.stageGone(exec, n, 'deliver', { jobs: false })(s) : undefined;
      const reason = prTestFault({
        n,
        pr,
        testCompleted: test?.status === 'completed',
        deliverRuns: k.stages(s, exec, n, ['deliver']).filter((r) => time(r.created_at) >= since),
        pendingOn,
        pendingReason,
      });
      return reason === undefined ? undefined : redact(reason, k.ctx.secretValues());
    };
    // A closed or merged PR for the branch that this wait never saw open is still named.
    const state = async (s: Snapshot) => {
      const reported = judged(s) ?? prOf(s);
      let test: Parameters<typeof prTestState>[2];
      if (reported)
        try {
          test = await testOf(reported);
        } catch (error) {
          test = { error: error instanceof Error ? error.message : String(error) };
        }
      return redact(`${prTestState(n, reported, test)}; ${await show(s)}`, k.ctx.secretValues());
    };
    return k.obs.until(
      "P's PR test check to complete",
      async (s) => {
        const pr = judged(s);
        if (!pr) return undefined;
        const test = await testOf(pr);
        return test?.status === 'completed' ? time(test.completed_at) : undefined;
      },
      DEADLINE.stage,
      state,
      { ...k.about(exec, n), expects, gonePast: firstOf(gone, own) },
    );
  };

  const testDone = await prTest(async (s) => {
    if (!isOpen(k, s, n)) return `P closed while waiting for its PR's test: ${await k.summary(s, exec, n)}`;
    if (!hasLabel(k, s, n, 'shaped'))
      return `P lost shaped while waiting for its PR's test: ${await k.summary(s, exec, n)}`;
    return k.stageGone(exec, n, 'deliver', { since: pendAt - 60_000, allowPending: true })(s);
  }, { pending: OWN_PENDING }, (reshapedAt ?? editedAt) - 60_000);
  const quiet = await k.settle("P's PR test", testDone, ofP);
  const reviewWhilePending = k.stages(quiet, exec, n, ['review']).filter((r) => time(r.created_at) >= pendAt).length;
  // The hold is only shown when PR CI completed, and so woke the review, after `pending` was on.
  const reviewBefore = k.stages(quiet, exec, n, ['review']).filter((r) => time(r.created_at) < pendAt).length;
  const pendingLate = reviewBefore
    ? `${reviewBefore} review run(s) started before pending was added`
    : testDone < pendAt
      ? `the PR's test completed before pending was added`
      : undefined;
  await k.removeLabel(exec, n, 'pending');
  const unpendedAt = k.now();
  await k.obs.until('P to close with delivered', (s) => k.delivered(s, exec, n), DEADLINE.delivery, show, {
    ...k.about(exec, n),
    gonePast: k.closeGone(exec, n),
  });
  return {
    p,
    pausedAt,
    pauseLate,
    deliverWhilePaused,
    editedAt,
    sentBack,
    reshapedAt,
    pendingAt: pendAt,
    reviewWhilePending,
    pendingLate,
    unpendedAt,
  };
}
