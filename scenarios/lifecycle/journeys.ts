// Shared deliveries: one set of fixtures, driven once, that several scenarios assert on.
// A journey performs every harness write its scenarios need and records the moments
// they check; the scenarios then read GitHub to judge them.
import { selfHosted, time, wakeRuns } from './analysis.ts';
import type { Issue, Job, Pull, Run } from './analysis.ts';
import { DEADLINE, changeRequest } from './kit.ts';
import type { Kit } from './kit.ts';
import type { Snapshot } from './observe.ts';

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
  const aBeforeScope = { stageRuns: k.stages(calm, exec, a.number).length, comments: (await k.obs.comments(exec, a.number)).length };
  await k.addLabels(exec, a.number, ['scope']);
  const aScopedAt = k.now();

  // R4.35: two wakes while A's Deliver runs.
  const deliverJob = await k.obs.until(
    'A\'s deliver job to run',
    async (s) => (await k.agentJobs(s, exec, a.number, ['deliver'])).find((j) => j.status === 'in_progress'),
    DEADLINE.delivery,
    k.show(exec, a.number),
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
  await k.obs.until('the CI re-run to start', (s) => {
    const r = pushRun(s, 'CI');
    return r && (r.run_attempt ?? 1) >= 2 && r.status !== 'completed' ? r : undefined;
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

  await k.obs.until('A to close with delivered', (s) => k.delivered(s, exec, a.number), DEADLINE.delivery, k.show(exec, a.number));
  for (const [name, n] of [['B', b.number], ['C', c.number], ['X', x.number]] as const) {
    await k.obs.until(`${name} to close with delivered`, (s) => k.delivered(s, exec, n), DEADLINE.delivery, k.show(exec, n));
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
  /** Deliver runs of P after the Shape was published while `pause` was on. */
  deliverWhilePaused: number;
  shapedWhilePaused: boolean;
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

  await k.obs.until('P\'s shape job to run', running('shape'), DEADLINE.stage, show);
  await k.addLabels(exec, n, ['pause']);
  const pausedAt = k.now();
  const shaped = await k.obs.until('P\'s Shape to be published', (s) => (hasLabel(k, s, n, 'shaped') ? s : undefined), DEADLINE.stage, show);
  const ofP = k.runsOf(exec, n);
  const calm = await k.settle('P shaped', shaped.at, ofP);
  const deliverWhilePaused = k.stages(calm, exec, n, ['deliver']).length;
  const shapedWhilePaused = hasLabel(k, calm, n, 'shaped');

  await k.gh.rest('PATCH', `/repos/${exec}/issues/${n}`, {
    body: changeRequest(slug, 'quadruple', 'returns its argument times four', 'This replaces the earlier `triple` request: there must be no `triple` function.'),
  });
  const editedAt = k.now();
  await k.removeLabel(exec, n, 'pause');

  const next = await k.obs.until(
    'Deliver to send the Shape back or open a PR',
    (s) => {
      if (!hasLabel(k, s, n, 'shaped')) return 'sent back' as const;
      if (s.pulls.get(exec)?.some((pr) => pr.head.ref === `nibfin/issue-${n}`)) return 'pr' as const;
      return undefined;
    },
    DEADLINE.stage,
    show,
  );
  let reshapedAt: number | undefined;
  if (next === 'sent back') {
    await k.obs.until('P to be shaped again', (x) => (hasLabel(k, x, n, 'shaped') ? x : undefined), DEADLINE.stage, show);
    // The label's own time, not the snapshot's: a Deliver may start before the next snapshot.
    reshapedAt = await k.labeledAt(exec, n, 'shaped', editedAt);
    if (reshapedAt === undefined) throw new Error(`#${n} shows \`shaped\` again but its timeline has no labeled event after the edit`);
  }
  // After a send-back the next Deliver is the one to hold; otherwise Deliver already opened the PR.
  if (reshapedAt !== undefined) await k.obs.until('P\'s next deliver job to run', running('deliver', reshapedAt), DEADLINE.stage, show);
  await k.addLabels(exec, n, ['pending']);
  const pendingAt = k.now();

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
  await k.obs.until('P to close with delivered', (s) => k.delivered(s, exec, n), DEADLINE.delivery, show);
  return { p, pausedAt, deliverWhilePaused, shapedWhilePaused, editedAt, sentBack: next === 'sent back', reshapedAt, pendingAt, reviewWhilePending, pendingLate, unpendedAt };
}
