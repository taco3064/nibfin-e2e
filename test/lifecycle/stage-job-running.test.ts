// The hold journey's first wait reads P's shape jobs directly (Issue #544, Proposal R4.12):
// a shape job running for less than one snapshot interval is still found, and one that
// completed before any read saw it running ends the wait at once with its own reason.
import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../../scenarios/lifecycle/analysis.ts';
import { stageJobRunning } from '../../scenarios/lifecycle/journeys.ts';
import { DEADLINE, Kit, STALL } from '../../scenarios/lifecycle/kit.ts';
import { clock, context, routes } from './fake.ts';

const T0 = Date.parse('2026-11-26T10:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const base = { 'GET /repos/o/peer/actions/runs': { workflow_runs: [] }, 'GET /repos/o/peer/issues': [], 'GET /repos/o/peer/pulls': [], 'GET /repos/o/exec/pulls': [], 'GET /rate_limit': {} };
const run = (id: number, stage: string, status: string, created: string, conclusion: string | null = status === 'completed' ? 'success' : null) => ({
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
/** A self-hosted shape job of run 5 that is queued until `from`, in progress until `to`, then completed. */
const timedJob = (now: () => number, from: number, to: number): Job => {
  const t = now() - T0;
  const status = t < from ? 'queued' : t < to ? 'in_progress' : 'completed';
  return {
    id: 11,
    run_id: 5,
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
const direct = (calls: string[], runId: number) => calls.filter((c) => c.startsWith(`GET /repos/o/exec/actions/runs/${runId}/jobs?filter=latest`));

test('a shape job in progress for less than one snapshot interval is found by the direct reads', async () => {
  const c = clock(T0);
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [run(5, 'shape', 'in_progress', iso(30_000))] },
    'GET /repos/o/exec/actions/runs/5/jobs': () => ({ jobs: [timedJob(c.now, 70_000, 100_000)] }),
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const j = await stageJobRunning(k, 6, 'shape', { desc: 'P\'s shape job to run', deadlineMs: DEADLINE.stage, show: k.show('o/exec', 6) });
  deepEqual([j.id, j.status, j.stage, j.run.id], [11, 'in_progress', 'shape', 5]);
  equal(c.now() - T0 < 100_000, true, 'found while it was running');
  equal(direct(f.calls, 5).length >= 7, true, 'read directly every 10 s');
  equal(direct(f.calls, 5)[0], 'GET /repos/o/exec/actions/runs/5/jobs?filter=latest&per_page=100&page=1');
});

test('a shape job that completed before any read saw it running ends the wait at once with its own reason', async () => {
  const c = clock(T0);
  const runs = () => [run(5, 'shape', c.now() - T0 < 67_000 ? 'in_progress' : 'completed', iso(30_000)), ...(c.now() - T0 >= 66_000 ? [run(7, 'deliver', 'in_progress', iso(66_000))] : [])];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs() }),
    'GET /repos/o/exec/actions/runs/5/jobs': () => ({ jobs: [timedJob(c.now, 62_000, 65_000)] }),
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await rejects(
    stageJobRunning(k, 6, 'shape', { desc: 'P\'s shape job to run', deadlineMs: DEADLINE.stage, show: k.show('o/exec', 6) }),
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
    'GET /repos/o/exec/actions/runs': { workflow_runs: [run(5, 'shape', 'completed', iso(10_000), 'cancelled'), run(8, 'shape', 'in_progress', iso(40_000))] },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [cancelled] },
    'GET /repos/o/exec/actions/runs/8/jobs': () => ({ jobs: [{ ...timedJob(c.now, 20_000, 50_000), id: 12, run_id: 8 }] }),
    'GET /repos/o/exec/issues': [issue],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const j = await stageJobRunning(k, 6, 'shape', { desc: 'P\'s shape job to run', deadlineMs: DEADLINE.stage });
  deepEqual([j.id, j.run.id], [12, 8]);
  equal(direct(f.calls, 5).length, 1, 'the cancelled run is read once');
});
