// Shared deliveries: one set of fixtures, driven once, that several scenarios assert on.
// A journey performs every harness write its scenarios need and records the moments
// they check; the scenarios then read GitHub to judge them.
import { AGENT_STAGES, selfHosted, time, wakeRuns } from './analysis.ts';
import type { Issue, Job, Pull, Run, Stage } from './analysis.ts';
import { DEADLINE, changeRequest, redact } from './kit.ts';
import type { Kit } from './kit.ts';
import type { Snapshot } from './observe.ts';
import { sleep, waitFor } from '../lib/wait.ts';
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

/**
 * Waits for a self-hosted job of an Issue's `stage` to be `in_progress`, reading the
 * jobs of the Issue's unfinished runs of that stage directly every `DIRECT_READ_MS`
 * rather than through the observer's snapshot and its cached job reads, which may miss a
 * short job (Issue #544). The wait fails at once when such a job completed before any
 * read saw it running, and otherwise ends on `stageGone`, the stall limit or the deadline.
 */
export async function stageJobRunning(
  k: Kit,
  n: number,
  stage: Stage,
  o: { desc: string; deadlineMs: number; show?: (s: Snapshot) => Promise<string>; /** The Issue's name in the reason (default `P`). */ who?: string },
): Promise<Job & { stage: Stage; run: Run }> {
  const pause = k.sleep ?? sleep;
  const iso = (t: number) => new Date(t).toISOString();
  /** Runs that completed without running an agent job (cancelled or skipped). */
  const finished = new Set<number>();
  /** The previous direct read of each job: when, and its status then. */
  const lastRead = new Map<number, { at: number; status: string }>();
  let missed: string | undefined;
  const read = async (run: Run & { stage: Stage }): Promise<(Job & { stage: Stage; run: Run }) | undefined> => {
    const at = k.now();
    const jobs = await k.gh.list<Job>(`/repos/${k.exec}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
    const own = jobs.filter(selfHosted);
    const live = own.find((j) => j.status === 'in_progress');
    if (live) return { ...live, stage, run };
    const done = own.find((j) => j.status === 'completed' && j.conclusion !== 'cancelled' && j.conclusion !== 'skipped');
    if (done) {
      const prev = lastRead.get(done.id);
      const seen = prev ? `the wait last read it at ${iso(prev.at)} (${prev.status})` : `on its first read at ${iso(at)}`;
      missed = redact(
        `${o.who ?? 'P'}'s ${stage} job ${done.id} (run ${run.id}) completed (${String(done.conclusion)}) before the wait saw it running: started ${String(done.started_at)}, completed ${String(done.completed_at)}; ${seen}`,
        k.ctx.secretValues(),
      );
      return undefined;
    }
    for (const j of own) lastRead.set(j.id, { at, status: j.status });
    if (run.status === 'completed' && jobs.every((j) => j.status === 'completed')) finished.add(run.id);
    return undefined;
  };
  const fn = async (s: Snapshot) => {
    const until = k.now() + DIRECT_SPAN_MS;
    for (;;) {
      if (missed !== undefined) return undefined;
      const runs = k.stages(s, k.exec, n, [stage]).filter((r) => !finished.has(r.id));
      if (!runs.length) return undefined;
      for (const run of runs) {
        const j = await read(run);
        if (j || missed !== undefined) return j;
      }
      if (k.now() + DIRECT_READ_MS > until) return undefined;
      await untilAborted(pause(DIRECT_READ_MS), k.ctx.signal);
    }
  };
  return k.obs.until(o.desc, fn, o.deadlineMs, o.show, { gonePast: firstOf(async () => missed, k.stageGone(k.exec, n, stage)) });
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
  /** The Deliver job of A during which `e2e-wake` was toggled twice. */
  wakeToggles: { jobId: number; at: number[] };
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

  const a = await k.file(exec, { scenario: 'delivery-lifecycle', title: 'Add triple', body: changeRequest(slugA, 'triple', 'returns its argument times three'), assignees: [owner.login] });
  const b = await k.file(exec, { scenario: 'delivery-blocked-by-chain', title: 'Add double', body: changeRequest(k.slug('b'), 'double', 'returns its argument times two'), assignees: [owner.login] });
  const c = await k.file(exec, { scenario: 'delivery-blocked-by-chain', title: 'Add negate', body: changeRequest(k.slug('c'), 'negate', 'returns its argument negated'), assignees: [owner.login] });
  await k.blockBy(exec, b.number, [a]);
  await k.blockBy(exec, c.number, [b]);
  await k.addLabels(exec, b.number, ['scope']);
  const lastB = k.now();
  await k.addLabels(exec, c.number, ['scope']);
  const lastC = k.now();
  const x = await k.file(exec, {
    scenario: 'delivery-parallel',
    title: 'Add square',
    body: changeRequest(k.slug('x'), 'square', 'returns its argument squared', `Please deliver this with the codex provider.\n\nBlocked by #${c.number}`),
    labels: ['scope'],
    assignees: [owner.login],
  });
  const u = await k.file(exec, { scenario: 'delivery-blocked-by-chain', title: 'Add halve', body: changeRequest(k.slug('u'), 'halve', 'returns half its argument'), labels: ['scope'] });
  filed.push(a.number, b.number, c.number, x.number, u.number);

  // R4.7: A without `scope` gets no stage and no comment once its opened wake completed.
  await k.obs.until('A\'s opened wake run to complete', (s) => (wakeRuns(s.runs, exec, a.number).some((r) => r.status === 'completed') ? true : undefined), DEADLINE.event, k.show(exec, a.number));
  const calm = await k.settle('A opened', k.now(), k.runsOf(exec, a.number));
  // Route may run for any Issue event; only an agent stage would mean A was taken up.
  const aBeforeScope = { stageRuns: k.stages(calm, exec, a.number, AGENT_STAGES).length, comments: (await k.obs.comments(exec, a.number)).length };
  await k.addLabels(exec, a.number, ['scope']);
  const aScopedAt = k.now();

  // R4.35: two wakes while A's Deliver runs.
  const deliverJob = await k.obs.until(
    'A\'s deliver job to run',
    async (s) => (await k.agentJobs(s, exec, a.number, ['deliver'])).find((j) => j.status === 'in_progress'),
    DEADLINE.delivery,
    k.show(exec, a.number),
    { gonePast: k.stageGone(exec, a.number, 'deliver') },
  );
  const toggles: number[] = [];
  for (let i = 0; i < 2; i++) {
    toggles.push(k.now());
    await k.addLabels(exec, a.number, ['e2e-wake']);
    await k.removeLabel(exec, a.number, 'e2e-wake');
  }

  const branch = `nibfin/issue-${a.number}`;
  const aPr = await k.obs.until('A\'s PR to merge', (s) => s.pulls.get(exec)?.find((p) => p.head.ref === branch && p.merged_at), DEADLINE.delivery, k.show(exec, a.number));
  const { data: main } = await k.gh.rest<{ commit: { sha: string } }>('GET', `/repos/${exec}/branches/main`);
  const mergeSha = aPr.merge_commit_sha ?? main.commit.sha;
  const pushRun = (s: Snapshot, name: string) => s.runs.find((r) => r.repo === exec && r.name === name && r.event === 'push' && r.head_sha === mergeSha);

  // R3.31, R3.34: CI attempt 1 completes while CD is held; A stays open.
  const ciRun = await k.obs.until('CI attempt 1 of A\'s merge to complete', (s) => {
    const r = pushRun(s, 'CI');
    return r && r.status === 'completed' && (r.run_attempt ?? 1) === 1 ? r : undefined;
  }, DEADLINE.event);
  // What a CI or CD completion of the merge wakes: A's own runs and Nibfin's runs for the merge commit.
  const ofA = k.runsOf(exec, a.number);
  const forMerge = (r: Run) => r.display_title.startsWith('Nibfin ·') && r.display_title.includes(`@${mergeSha.slice(0, 7)}`);
  const heldCd = (r: Run) => r.name === 'CD' && r.head_sha === mergeSha;
  const afterCi = await k.settle('CI of A\'s merge', time(ciRun.updated_at), (r) => (ofA(r) || forMerge(r)) && !heldCd(r));
  const openWhileCdHeld = isOpen(k, afterCi, a.number) && pushRun(afterCi, 'CD')?.status !== 'completed';

  // R3.36: a re-run attempt of CI that starts before CD completes, still running when it does.
  await k.gh.rest('POST', `/repos/${exec}/actions/runs/${ciRun.id}/rerun`);
  // Read the run itself: a re-run keeps its created_at, which may be older than the observer's listing window.
  await k.obs.until('the CI re-run to start', async () => {
    const { data: r } = await k.gh.rest<Run>('GET', `/repos/${exec}/actions/runs/${ciRun.id}`);
    return (r.run_attempt ?? 1) >= 2 && r.status !== 'completed' ? r : undefined;
  }, DEADLINE.event);
  await k.gh.rest('POST', `/repos/${exec}/git/refs`, { ref: `refs/tags/${t}-a-cd`, sha: mergeSha });
  const cdRun = await k.obs.until('CD of A\'s merge to complete', (s) => {
    const r = pushRun(s, 'CD');
    return r?.status === 'completed' ? r : undefined;
  }, DEADLINE.event);
  const heldCi = (r: Run) => r.name === 'CI' && r.head_sha === mergeSha;
  const afterCd = await k.settle('CD of A\'s merge', time(cdRun.updated_at), (r) => (ofA(r) || forMerge(r)) && !heldCi(r));
  const openAfterCd = isOpen(k, afterCd, a.number);
  await k.gh.rest('POST', `/repos/${exec}/git/refs`, { ref: `refs/tags/${t}-a-ci2`, sha: mergeSha });

  await k.obs.until('A to close with delivered', (s) => k.delivered(s, exec, a.number), DEADLINE.delivery, k.show(exec, a.number), { gonePast: k.closeGone(exec, a.number) });
  for (const [name, n] of [['B', b.number], ['C', c.number], ['X', x.number]] as const) {
    await k.obs.until(`${name} to close with delivered`, (s) => k.delivered(s, exec, n), DEADLINE.delivery, k.show(exec, n), { gonePast: k.closeGone(exec, n) });
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
    wakeToggles: { jobId: deliverJob.id, at: toggles },
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
  /** Deliver runs of P created while `pause` was on, once P's runs settled. */
  deliverWhilePaused: number;
  /**
   * How the Shape that was running when `pause` was added ended: `published` (`shaped`
   * appeared while `pause` was on) or `held` (it completed without `shaped`; the Shape
   * is redone once `pause` is removed).
   */
  pauseOutcome: 'published' | 'held';
  /** When `pause` was removed to let the Shape be redone (`held` only). */
  unpausedAt?: number;
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

export type PauseOutcome = { kind: 'published' } | { kind: 'held' } | { kind: 'fault'; reason: string };

/**
 * How the Shape running when `pause` was added ended, from P's state once its runs
 * settled with `pause` still on. Proposal R4.12 does not say whether a running Shape
 * publishes before it stops, so both `published` and `held` are valid.
 */
export function pauseOutcome(i: { open: boolean; labels: string[]; shapedAddedWhilePaused: boolean }): PauseOutcome {
  if (!i.open) return { kind: 'fault', reason: 'P closed while pause was on' };
  if (i.labels.includes('pending')) return { kind: 'fault', reason: 'P got pending while pause was on' };
  if (i.labels.includes('shaped')) return { kind: 'published' };
  if (i.shapedAddedWhilePaused) return { kind: 'fault', reason: '`shaped` was added and removed while pause was on' };
  return { kind: 'held' };
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
  const running = (stage: 'shape' | 'deliver', after = 0) => async (s: Snapshot) =>
    (await k.agentJobs(s, exec, n, [stage])).find((j: Job) => j.status === 'in_progress' && selfHosted(j) && time(j.started_at) >= after);

  const shapeJob = await stageJobRunning(k, n, 'shape', { desc: 'P\'s shape job to run', deadlineMs: DEADLINE.stage, show });
  await k.addLabels(exec, n, ['pause']);
  const pausedAt = k.now();
  const shapeDone = await k.obs.until('P\'s shape job to complete', async () => {
    const j = await k.obs.job(exec, shapeJob.id);
    return j.status === 'completed' ? j : undefined;
  }, DEADLINE.stage, show);
  const pauseLate = time(shapeDone.completed_at) <= pausedAt ? `P's shape job ${shapeDone.id} completed before pause was added` : undefined;
  // With `pause` on, the running Shape may be published and then held, or held before it
  // is published (Proposal R4.12 allows both). Settle P's runs woken after `pause` (for
  // example by `shaped` being added) and judge it from P's state while still paused.
  const ofP = k.runsOf(exec, n);
  const calm = await k.settle('P paused', pausedAt, ofP);
  const pi = k.issue(calm, exec, n);
  const decided = pauseOutcome({
    open: pi?.state === 'open',
    labels: k.labels(calm, exec, n),
    shapedAddedWhilePaused: (await k.labeledAt(exec, n, 'shaped', time(shapeJob.started_at))) !== undefined,
  });
  if (decided.kind === 'fault') throw new Error(`${decided.reason}: ${await k.summary(calm, exec, n)}`);
  const deliverWhilePaused = k.stages(calm, exec, n, ['deliver']).length;
  const edit = async () => {
    await k.gh.rest('PATCH', `/repos/${exec}/issues/${n}`, {
      body: changeRequest(slug, 'quadruple', 'returns its argument times four', 'This replaces the earlier `triple` request: there must be no `triple` function.'),
    });
    return k.now();
  };

  let editedAt: number;
  let unpausedAt: number | undefined;
  if (decided.kind === 'published') {
    editedAt = await edit();
    await k.removeLabel(exec, n, 'pause');
  } else {
    // Held before publishing: removing `pause` is the event that lets the Shape be redone
    // (Proposal R1.12, R3.41). The edit must land before any Deliver of P starts, so the
    // labels are read directly at a short interval once the redone shape job has started.
    await k.removeLabel(exec, n, 'pause');
    unpausedAt = k.now();
    const since = unpausedAt;
    await k.obs.until(
      'P\'s Shape to be redone after pause was removed',
      async (s) => (await k.agentJobs(s, exec, n, ['shape'])).find((j) => time(j.started_at) >= since),
      DEADLINE.stage,
      show,
      { gonePast: k.stageGone(exec, n, 'shape', { since: since - 60_000 }) },
    );
    const read = async () => (await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`)).data;
    const names = (i: Issue) => i.labels.map((l) => l.name);
    const published = await waitFor(read, (i) => i.state !== 'open' || names(i).includes('shaped') || names(i).includes('pending'), {
      what: 'P\'s Shape to be published after pause was removed',
      deadlineMs: Math.max(0, DEADLINE.stage - (k.now() - since)),
      intervalMs: 5_000,
      now: () => k.now(),
      sleep: k.sleep,
      signal: k.ctx.signal,
    });
    // Closed or `pending` is a fault even when `shaped` is also on: no Deliver can start
    // while `pending` is on, so the waits after the edit could only end at the stall limit.
    if (published.state !== 'open' || names(published).includes('pending')) {
      const state = published.state !== 'open' ? 'is closed' : 'has pending';
      throw new Error(`P ${state} while waiting for its Shape to be published after pause was removed: ${await k.summary(await k.obs.fresh(), exec, n)}`);
    }
    editedAt = await edit();
  }
  // Held case: a Deliver that started before the edit cannot meet the contradicted Shape.
  const deliverBeforeEdit = async (s: Snapshot) => {
    if (unpausedAt === undefined) return undefined;
    const from = unpausedAt;
    const j = (await k.agentJobs(s, exec, n, ['deliver'])).find((x) => time(x.started_at) >= from && time(x.started_at) < editedAt);
    return j
      ? `P's deliver job ${j.id} started at ${String(j.started_at)}, before the edit at ${new Date(editedAt).toISOString()} that followed the Shape redone after pause; the contradicted-Shape steps cannot be exercised`
      : undefined;
  };

  // Held case: the first wait after the edit can start on a snapshot read before the
  // redone Shape was published, which lacks `shaped` without any send-back. So a missing
  // `shaped` counts as sent back only when P's timeline, read now, shows `shaped` removed
  // after the edit. A timeline cached before the edit can only delay this to a later snapshot.
  const removedAfterEdit = async () =>
    (await k.obs.timeline(exec, n)).some((e) => e.event === 'unlabeled' && e.label?.name === 'shaped' && time(e.created_at) >= Math.floor(editedAt / 1000) * 1000);
  const outcome = async (s: Snapshot) => {
    if (!hasLabel(k, s, n, 'shaped') && (unpausedAt === undefined || (await removedAfterEdit()))) return 'sent back' as const;
    if (s.pulls.get(exec)?.some((pr) => pr.head.ref === `nibfin/issue-${n}`)) return 'pr' as const;
    return undefined;
  };
  // Put `pending` on while the first Deliver after the edit runs, before it can open a
  // PR whose CI would wake a review. If that Deliver sends the Shape back instead,
  // `pending` comes off for the re-Shape and goes on again during the next Deliver.
  const first = await k.obs.until(
    'P\'s first Deliver after the edit',
    // A Deliver that started before the edit is left to `gonePast`, which names it.
    async (s) => ((await deliverBeforeEdit(s)) ? undefined : ((await outcome(s)) ?? ((await running('deliver', editedAt)(s)) ? ('running' as const) : undefined))),
    DEADLINE.stage,
    show,
    { gonePast: firstOf(deliverBeforeEdit, k.stageGone(exec, n, 'deliver', { since: editedAt - 60_000, allowPending: true })) },
  );
  let pendingAt: number | undefined;
  if (first === 'running') {
    await k.addLabels(exec, n, ['pending']);
    pendingAt = k.now();
  }
  const next = first === 'running' ? await k.obs.until('Deliver to send the Shape back or open a PR', outcome, DEADLINE.stage, show, { gonePast: k.stageGone(exec, n, 'deliver', { since: editedAt - 60_000, allowPending: true }) }) : first;
  let reshapedAt: number | undefined;
  if (next === 'sent back') {
    if (pendingAt !== undefined) await k.removeLabel(exec, n, 'pending');
    await k.obs.until('P to be shaped again', (x) => (hasLabel(k, x, n, 'shaped') ? x : undefined), DEADLINE.stage, show);
    // The label's own time, not the snapshot's: a Deliver may start before the next snapshot.
    reshapedAt = await k.labeledAt(exec, n, 'shaped', editedAt);
    if (reshapedAt === undefined) throw new Error(`#${n} shows \`shaped\` again but its timeline has no labeled event after the edit`);
    await k.obs.until('P\'s next deliver job to run', running('deliver', reshapedAt), DEADLINE.stage, show, { gonePast: k.stageGone(exec, n, 'deliver', { since: reshapedAt - 60_000 }) });
    await k.addLabels(exec, n, ['pending']);
    pendingAt = k.now();
  } else if (pendingAt === undefined) {
    // The PR was already open when first seen; the late-pending check below reports it.
    await k.addLabels(exec, n, ['pending']);
    pendingAt = k.now();
  }

  const testDone = await k.obs.until(
    'P\'s PR test check to complete',
    async (s) => {
      const pr = s.pulls.get(exec)?.find((x) => x.head.ref === `nibfin/issue-${n}` && x.state === 'open');
      if (!pr) return undefined;
      const test = (await k.obs.checkRuns(exec, pr.head.sha)).find((c) => c.name === 'test');
      return test?.status === 'completed' ? time(test.completed_at) : undefined;
    },
    DEADLINE.stage,
    show,
  );
  const quiet = await k.settle('P\'s PR test', testDone, ofP);
  const reviewWhilePending = k.stages(quiet, exec, n, ['review']).filter((r) => time(r.created_at) >= pendingAt).length;
  // The hold is only shown when PR CI completed, and so woke the review, after `pending` was on.
  const reviewBefore = k.stages(quiet, exec, n, ['review']).filter((r) => time(r.created_at) < pendingAt).length;
  const pendingLate = reviewBefore
    ? `${reviewBefore} review run(s) started before pending was added`
    : testDone < pendingAt
      ? `the PR's test completed before pending was added`
      : undefined;
  await k.removeLabel(exec, n, 'pending');
  const unpendedAt = k.now();
  await k.obs.until('P to close with delivered', (s) => k.delivered(s, exec, n), DEADLINE.delivery, show, { gonePast: k.closeGone(exec, n) });
  return { p, pausedAt, pauseLate, deliverWhilePaused, pauseOutcome: decided.kind, unpausedAt, editedAt, sentBack: next === 'sent back', reshapedAt, pendingAt, reviewWhilePending, pendingLate, unpendedAt };
}
