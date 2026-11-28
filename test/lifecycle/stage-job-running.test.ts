// The hold journey's first wait watches P, so the observer reads P's runs and shape jobs
// every watch interval (Issue #544, Proposal R4.12): a shape job running for less than one
// snapshot interval is still found, and one that completed before any read saw it running
// ends the wait at once with its own reason.
import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../../scenarios/lifecycle/analysis.ts';
import { stageJobRunning, stageJobRunningOrMissed } from '../../scenarios/lifecycle/journeys.ts';
import { deliverWithCommits } from '../../scenarios/lifecycle/phase1.ts';
import { DEADLINE, Kit, STALL } from '../../scenarios/lifecycle/kit.ts';
import { clock, context, routes } from './fake.ts';

const T0 = Date.parse('2026-11-26T10:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const base = {
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /repos/o/exec/pulls': [],
  'GET /rate_limit': {},
};
const run = (
  id: number,
  stage: string,
  status: string,
  created: string,
  conclusion: string | null = status === 'completed' ? 'success' : null,
) => ({
  id,
  display_title: `Nibfin · o/exec#6 · ${stage}`,
  status,
  conclusion,
  created_at: created,
  name: 'Nibfin',
  event: 'workflow_dispatch',
  head_sha: 'h',
});
const issue = { number: 6, title: 't', state: 'open', labels: [{ name: 'scope' }] };
/** A self-hosted job (by default job 11 of shape run 5) that is queued until `from`, in progress until `to`, then completed. */
const timedJob = (
  now: () => number,
  from: number,
  to: number,
  ids: { id: number; run: number } = { id: 11, run: 5 },
): Job => {
  const t = now() - T0;
  const status = t < from ? 'queued' : t < to ? 'in_progress' : 'completed';
  return {
    id: ids.id,
    run_id: ids.run,
    name: 'stage',
    status,
    conclusion: status === 'completed' ? 'success' : null,
    labels: ['self-hosted', 'nibfin-1'],
    runner_name: status === 'queued' ? null : 'claude-1',
    created_at: iso(30_000),
    started_at: status === 'queued' ? null : iso(from),
    completed_at: status === 'completed' ? iso(to) : null,
  };
};
const jobReads = (calls: string[], runId: number) =>
  calls.filter((c) => c.startsWith(`GET /repos/o/exec/actions/runs/${runId}/jobs?filter=all`));

test('a shape job in progress for less than one snapshot interval is found by the watched reads', async () => {
  const c = clock(T0);
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [run(5, 'shape', 'in_progress', iso(30_000))] },
    'GET /repos/o/exec/actions/runs/5/jobs': () => ({ jobs: [timedJob(c.now, 70_000, 100_000)] }),
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const j = await stageJobRunning(k, 6, 'shape', {
    desc: "P's shape job to run",
    deadlineMs: DEADLINE.stage,
    show: k.show('o/exec', 6),
  });
  deepEqual([j.id, j.status, j.stage, j.run.id], [11, 'in_progress', 'shape', 5]);
  equal(c.now() - T0 < 100_000, true, 'found while it was running');
  equal(jobReads(f.calls, 5).length >= 7, true, 'read every 10 s');
  equal(jobReads(f.calls, 5)[0], 'GET /repos/o/exec/actions/runs/5/jobs?filter=all&per_page=100&page=1');
});

test('a shape job that completed before any read saw it running ends the wait at once with its own reason', async () => {
  const c = clock(T0);
  const runs = () => [
    run(5, 'shape', c.now() - T0 < 67_000 ? 'in_progress' : 'completed', iso(30_000)),
    ...(c.now() - T0 >= 66_000 ? [run(7, 'deliver', 'in_progress', iso(66_000))] : []),
  ];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs() }),
    'GET /repos/o/exec/actions/runs/5/jobs': () => ({ jobs: [timedJob(c.now, 62_000, 65_000)] }),
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await rejects(
    stageJobRunning(k, 6, 'shape', {
      desc: "P's shape job to run",
      deadlineMs: DEADLINE.stage,
      show: k.show('o/exec', 6),
    }),
    new RegExp(
      `^Error: gave up waiting for P's shape job to run: P's shape job 11 \\(run 5\\) completed \\(success\\) before the wait saw it running: started ${iso(62_000)}, completed ${iso(65_000)}; the wait last read it at ${iso(60_000)} \\(queued\\); observed: o/exec#6 open`,
    ),
  );
  equal(c.now() - T0 < 2 * 60_000, true, 'it ended on the read that saw it completed');
  equal(c.now() - T0 < STALL, true);
});

test('a shape run that ended without running its job is left for a newer shape run', async () => {
  const c = clock(T0);
  const cancelled: Job = { ...timedJob(c.now, 0, 0), conclusion: 'cancelled', started_at: null };
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [
        run(5, 'shape', 'completed', iso(10_000), 'cancelled'),
        run(8, 'shape', 'in_progress', iso(40_000)),
      ],
    },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [cancelled] },
    'GET /repos/o/exec/actions/runs/8/jobs': () => ({
      jobs: [{ ...timedJob(c.now, 20_000, 50_000), id: 12, run_id: 8 }],
    }),
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const j = await stageJobRunning(k, 6, 'shape', { desc: "P's shape job to run", deadlineMs: DEADLINE.stage });
  deepEqual([j.id, j.run.id], [12, 8]);
  equal(jobReads(f.calls, 5).length, 1, 'the cancelled run is read once');
});

// A's deliver wait in the delivery journey watches A the same way (Issue #567, Proposal R4.35).
test("a deliver job in progress for less than one snapshot interval is found by A's deliver wait", async () => {
  const c = clock(T0);
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [run(5, 'shape', 'completed', iso(0)), run(9, 'deliver', 'in_progress', iso(30_000))],
    },
    'GET /repos/o/exec/actions/runs/9/jobs': () => ({ jobs: [timedJob(c.now, 70_000, 100_000, { id: 21, run: 9 })] }),
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const j = await stageJobRunning(k, 6, 'deliver', {
    desc: "A's deliver job to run",
    deadlineMs: DEADLINE.delivery,
    show: k.show('o/exec', 6),
    who: 'A',
  });
  deepEqual([j.id, j.status, j.stage, j.run.id], [21, 'in_progress', 'deliver', 9]);
  equal(c.now() - T0 < 100_000, true, 'found while it was running');
  equal(jobReads(f.calls, 9).length >= 7, true, 'read every 10 s');
  equal(jobReads(f.calls, 5).length, 0, 'other stages are not read');
});

test("a deliver job that completed before any read saw it running ends A's deliver wait at once with its own reason", async () => {
  const c = clock(T0);
  // Deliver completes and Review follows, which alone would end the wait through stageGone.
  const runs = () => [
    run(9, 'deliver', c.now() - T0 < 67_000 ? 'in_progress' : 'completed', iso(30_000)),
    ...(c.now() - T0 >= 66_000 ? [run(10, 'review', 'in_progress', iso(66_000))] : []),
  ];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs() }),
    'GET /repos/o/exec/actions/runs/9/jobs': () => ({ jobs: [timedJob(c.now, 62_000, 65_000, { id: 21, run: 9 })] }),
    'GET /repos/o/exec/actions/runs/10/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await rejects(
    stageJobRunning(k, 6, 'deliver', {
      desc: "A's deliver job to run",
      deadlineMs: DEADLINE.delivery,
      show: k.show('o/exec', 6),
      who: 'A',
    }),
    new RegExp(
      `^Error: gave up waiting for A's deliver job to run: A's deliver job 21 \\(run 9\\) completed \\(success\\) before the wait saw it running: started ${iso(62_000)}, completed ${iso(65_000)}; the wait last read it at ${iso(60_000)} \\(queued\\); observed: o/exec#6 open`,
    ),
  );
  equal(c.now() - T0 < 2 * 60_000, true, 'it ended on the read that saw it completed');
  equal(c.now() - T0 < STALL, true);
});

// Step 3 of interrupted-deliver watches I's deliver jobs too, and needs a commit on
// I's branch while the job runs (Issue #581, Proposal R3.41, R1.14).
const compare = 'GET /repos/o/exec/compare/main...nibfin/issue-6';
const branchRead = 'GET /repos/o/exec/branches/nibfin/issue-6';

test("a deliver job in progress for less than one snapshot interval with a commit on its branch is found by I's step 3", async () => {
  const c = clock(T0);
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [run(5, 'shape', 'completed', iso(0)), run(9, 'deliver', 'in_progress', iso(30_000))],
    },
    'GET /repos/o/exec/actions/runs/9/jobs': () => ({ jobs: [timedJob(c.now, 70_000, 100_000, { id: 21, run: 9 })] }),
    [compare]: () => (c.now() - T0 < 80_000 ? { status: 404, data: { message: 'Not Found' } } : { ahead_by: 1 }),
    [branchRead]: { commit: { sha: 'h-1' } },
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const { oldJob, h1 } = await deliverWithCommits(k, 6, { since: T0, show: k.show('o/exec', 6) });
  deepEqual([oldJob.id, oldJob.status, oldJob.stage, oldJob.run.id], [21, 'in_progress', 'deliver', 9]);
  equal(h1, 'h-1');
  equal(c.now() - T0 < 100_000, true, 'found while it was running');
  equal(f.calls.filter((x) => x.startsWith(compare)).length > 1, true, 'the branch is read again while the job runs');
});

test("a deliver job that completed before any read saw it running ends I's step 3 at once with its times", async () => {
  const c = clock(T0);
  const runs = () => [
    run(9, 'deliver', c.now() - T0 < 67_000 ? 'in_progress' : 'completed', iso(30_000)),
    ...(c.now() - T0 >= 66_000 ? [run(10, 'review', 'in_progress', iso(66_000))] : []),
  ];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs() }),
    'GET /repos/o/exec/actions/runs/9/jobs': () => ({ jobs: [timedJob(c.now, 62_000, 65_000, { id: 21, run: 9 })] }),
    'GET /repos/o/exec/actions/runs/10/jobs': { jobs: [] },
    [compare]: { ahead_by: 1 },
    [branchRead]: { commit: { sha: 'h-1' } },
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await rejects(
    deliverWithCommits(k, 6, { since: T0, show: k.show('o/exec', 6) }),
    new RegExp(
      `^Error: gave up waiting for I's deliver job to run with commits on its branch: I's deliver job 21 \\(run 9\\) completed \\(success\\) before the wait saw it running: started ${iso(62_000)}, completed ${iso(65_000)}; the wait last read it at ${iso(60_000)} \\(queued\\); observed: o/exec#6 open`,
    ),
  );
  equal(c.now() - T0 < 2 * 60_000, true, 'it ended on the read that saw it completed');
  equal(c.now() - T0 < STALL, true);
});

for (const [name, answer, last] of [
  ['0 commits ahead', { ahead_by: 0 }, '0 commits ahead of main'],
  ['missing', { status: 404, data: { message: 'Not Found' } }, 'not found \\(404\\)'],
] as const) {
  test(`a deliver job seen running that completes while its branch is ${name} ends I's step 3 at once with the last branch read`, async () => {
    const c = clock(T0);
    const f = routes({
      ...base,
      'GET /repos/o/exec/actions/runs': () => ({
        workflow_runs: [run(9, 'deliver', c.now() - T0 < 120_000 ? 'in_progress' : 'completed', iso(30_000))],
      }),
      'GET /repos/o/exec/actions/runs/9/jobs': () => ({ jobs: [timedJob(c.now, 62_000, 120_000, { id: 21, run: 9 })] }),
      [compare]: answer,
      [branchRead]: { commit: { sha: 'h-1' } },
      'GET /repos/o/exec/issues': [issue],
    });
    const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
    await rejects(
      deliverWithCommits(k, 6, { since: T0, show: k.show('o/exec', 6) }),
      new RegExp(
        `^Error: gave up waiting for I's deliver job to run with commits on its branch: I's deliver job 21 \\(run 9\\) completed \\(success\\) after the wait saw it running, before a read saw a commit on its branch: started ${iso(62_000)}, completed ${iso(120_000)}; the branch was last read at ${iso(110_000)}: ${last}; observed: o/exec#6 open`,
      ),
    );
    equal(c.now() - T0 < 3 * 60_000, true, 'it ended on the read that saw it completed');
    equal(c.now() - T0 < STALL, true);
    equal(f.calls.some((x) => x.startsWith(branchRead)), false, 'no branch head is read without a commit');
  });
}

// When A's deliver job can no longer be seen running, the reason names what the watched reads
// saw, and the delivery journey goes on without its wakes (Proposal R4.35, R1.14).
const deliverWait = { desc: "A's deliver job to run", deadlineMs: DEADLINE.delivery, who: 'A' } as const;

test('a deliver run whose current attempt ran no job, followed by Review, names the watched reads and is a miss for the journey', async () => {
  for (const wait of [stageJobRunning, stageJobRunningOrMissed]) {
    const c = clock(T0);
    // Attempt 2 completed without a job; job 21 of attempt 1 completed, and Review followed.
    const runs = () => [
      { ...run(9, 'deliver', 'completed', iso(30_000)), run_attempt: 2 },
      ...(c.now() - T0 >= 66_000 ? [run(10, 'review', 'in_progress', iso(66_000))] : []),
    ];
    const f = routes({
      ...base,
      'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs() }),
      'GET /repos/o/exec/actions/runs/9/jobs': {
        jobs: [{ ...timedJob(() => T0 + 65_000, 62_000, 65_000, { id: 21, run: 9 }), run_attempt: 1 }],
      },
      'GET /repos/o/exec/actions/runs/10/jobs': { jobs: [] },
      'GET /repos/o/exec/issues': [issue],
    });
    const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
    const reason = new RegExp(
      `^gave up waiting for A's deliver job to run: #6's deliver job 21 completed \\(run 9, success\\) and a review run 10 followed; watched reads: run 9 \\(attempt 2\\) last read at ${iso(0)}: no self-hosted job; observed: o/exec#6 open`,
    );
    const o = { ...deliverWait, show: k.show('o/exec', 6) };
    if (wait === stageJobRunning) await rejects(stageJobRunning(k, 6, 'deliver', o), (e: Error) => reason.test(e.message));
    else {
      const r = await stageJobRunningOrMissed(k, 6, 'deliver', o);
      equal('missed' in r && reason.test(r.missed), true, JSON.stringify(r));
    }
    equal(c.now() - T0 < 90_000, true, 'it ended on the watched read that showed Review');
    equal(c.now() - T0 < STALL, true);
  }
});

test("a watched read that fails before A's deliver job is seen completed is named in the miss", async () => {
  const c = clock(T0);
  const runs = () => [
    run(9, 'deliver', c.now() - T0 < 67_000 ? 'in_progress' : 'completed', iso(30_000)),
    ...(c.now() - T0 >= 66_000 ? [run(10, 'review', 'in_progress', iso(66_000))] : []),
  ];
  const failing = () => c.now() - T0 > 60_000 && c.now() - T0 <= 70_000;
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs() }),
    'GET /repos/o/exec/actions/runs/9/jobs': () =>
      failing()
        ? { status: 502, data: { message: 'Bad Gateway' } }
        : { jobs: [timedJob(c.now, 62_000, 65_000, { id: 21, run: 9 })] },
    'GET /repos/o/exec/actions/runs/10/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await rejects(
    stageJobRunning(k, 6, 'deliver', { ...deliverWait, show: k.show('o/exec', 6) }),
    (e: Error) =>
      new RegExp(
        `^gave up waiting for A's deliver job to run: A's deliver job 21 \\(run 9\\) completed \\(success\\) before the wait saw it running: started ${iso(62_000)}, completed ${iso(65_000)}; the wait last read it at ${iso(60_000)} \\(queued\\); last watched read error at ${iso(70_000)} \\(run 9\\): [^;]*502`,
      ).test(e.message) || assertFail(e.message),
  );
  equal(c.now() - T0 < STALL, true);
});

test('a re-run attempt of a deliver run whose first attempt ran no job is read again', async () => {
  const c = clock(T0);
  const rerun = () => c.now() - T0 >= 40_000;
  const cancelled: Job = { ...timedJob(c.now, 0, 0, { id: 21, run: 9 }), conclusion: 'cancelled', started_at: null };
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({
      workflow_runs: [
        rerun()
          ? { ...run(9, 'deliver', 'in_progress', iso(30_000)), run_attempt: 2 }
          : { ...run(9, 'deliver', 'completed', iso(30_000), 'cancelled'), run_attempt: 1 },
      ],
    }),
    'GET /repos/o/exec/actions/runs/9/jobs': () => ({
      jobs: [rerun() ? timedJob(c.now, 70_000, 100_000, { id: 22, run: 9 }) : cancelled],
    }),
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const j = await stageJobRunning(k, 6, 'deliver', deliverWait);
  deepEqual([j.id, j.status, j.run.id, j.run.run_attempt], [22, 'in_progress', 9, 2]);
  equal(c.now() - T0 < 100_000, true, 'found while it was running');
});

test("a deliver job that completed before any read saw it running is a miss for A's deliver wait", async () => {
  const c = clock(T0);
  const runs = () => [
    run(9, 'deliver', c.now() - T0 < 67_000 ? 'in_progress' : 'completed', iso(30_000)),
    ...(c.now() - T0 >= 66_000 ? [run(10, 'review', 'in_progress', iso(66_000))] : []),
  ];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs() }),
    'GET /repos/o/exec/actions/runs/9/jobs': () => ({ jobs: [timedJob(c.now, 62_000, 65_000, { id: 21, run: 9 })] }),
    'GET /repos/o/exec/actions/runs/10/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const r = await stageJobRunningOrMissed(k, 6, 'deliver', { ...deliverWait, show: k.show('o/exec', 6) });
  equal('missed' in r, true);
  equal(
    'missed' in r &&
      new RegExp(
        `^gave up waiting for A's deliver job to run: A's deliver job 21 \\(run 9\\) completed \\(success\\) before the wait saw it running: started ${iso(62_000)}, completed ${iso(65_000)}; the wait last read it at ${iso(60_000)} \\(queued\\); observed: o/exec#6 open`,
      ).test(r.missed),
    true,
    JSON.stringify(r),
  );
  equal(c.now() - T0 < 2 * 60_000, true);
});

test("a closed A without delivered still ends A's deliver wait, naming the watched reads", async () => {
  const c = clock(T0);
  const closed = { ...issue, state: 'closed', state_reason: 'not_planned', closed_at: new Date(T0 - 3_600_000).toISOString() };
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [closed],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await rejects(
    stageJobRunningOrMissed(k, 6, 'deliver', deliverWait),
    /^Error: gave up waiting for A's deliver job to run: #6 is closed \(not_planned\) without delivered; watched reads: none saw a deliver run of #6$/,
  );
});

function assertFail(m: string): never {
  throw new Error(`unexpected reason: ${m}`);
}
