// Waits that end early (Issue #334): a goal out of reach, a stall, an abort; and the
// deterministic Runner-busy checks of interrupted-deliver.
import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { busyTogether, issueKey, jobWindow } from '../../scenarios/lifecycle/analysis.ts';
import type { Job } from '../../scenarios/lifecycle/analysis.ts';
import { DEADLINE, Kit } from '../../scenarios/lifecycle/kit.ts';
import { Observer } from '../../scenarios/lifecycle/observe.ts';
import { allBusyAt, busyGone } from '../../scenarios/lifecycle/phase1.ts';
import { clock, context, routes } from './fake.ts';

const MIN = 60_000;
const base = { 'GET /repos/o/peer/actions/runs': { workflow_runs: [] }, 'GET /repos/o/peer/issues': [], 'GET /repos/o/peer/pulls': [], 'GET /repos/o/exec/pulls': [], 'GET /rate_limit': {} };
const run = (id: number, stage: string, status: string, created: string, n = 6) => ({ id, display_title: `Nibfin · o/exec#${n} · ${stage}`, status, conclusion: status === 'completed' ? 'success' : null, created_at: created, name: 'Nibfin', event: 'workflow_dispatch', head_sha: 'h' });
const job = (id: number, runId: number, extra: Partial<Job> = {}): Job => ({
  id,
  run_id: runId,
  name: 'stage',
  status: 'completed',
  conclusion: 'success',
  labels: ['self-hosted', 'nibfin-1'],
  runner_name: 'claude-1',
  created_at: '2026-11-26T10:01:00Z',
  started_at: '2026-11-26T10:01:10Z',
  completed_at: '2026-11-26T10:20:00Z',
  ...extra,
});
const issue = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: 't', state: 'open', labels: [{ name: 'scope' }], ...extra });

test('a stage wait fails on the first snapshot showing the stage job completed and another stage followed, long before its deadline', async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [run(5, 'shape', 'completed', '2026-11-26T10:00:30Z'), run(7, 'deliver', 'in_progress', '2026-11-26T10:21:00Z')] },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [job(11, 5)] },
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }] })],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const started = c.now();
  await rejects(
    k.obs.until('I2\'s shape job to run', () => undefined, DEADLINE.stage, k.show('o/exec', 6), { gonePast: k.stageGone('o/exec', 6, 'shape') }),
    /^Error: gave up waiting for I2's shape job to run: #6's shape job 11 completed \(run 5, success\) and a deliver run 7 followed; observed: o\/exec#6 open \[scope, shaped\]/,
  );
  equal(c.now() - started < MIN, true, 'it ended on the first snapshot');
});

test('a completed stage job is not out of reach while no other stage followed, nor when it is older than the wait', async () => {
  const runs = [run(5, 'shape', 'completed', '2026-11-26T09:00:00Z'), run(7, 'deliver', 'completed', '2026-11-26T09:30:00Z'), run(9, 'shape', 'completed', '2026-11-26T10:00:30Z')];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: runs },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [job(11, 5, { created_at: '2026-11-26T09:00:10Z', completed_at: '2026-11-26T09:20:00Z' })] },
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/actions/runs/9/jobs': { jobs: [job(12, 9)] },
    'GET /repos/o/exec/issues': [issue(6)],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const s = await k.obs.next();
  // Job 11 completed before the wait and was followed by deliver 7; job 12 completed with nothing after it.
  equal(await k.stageGone('o/exec', 6, 'shape')(s), undefined);
  match((await k.stageGone('o/exec', 6, 'shape', { since: Date.parse('2026-11-26T08:00:00Z') })(s)) ?? '', /shape job 11 completed \(run 5, success\) and a deliver run 7 followed/);
  equal(await k.stageGone('o/exec', 6, 'shape', { since: Date.parse('2026-11-26T08:00:00Z'), jobs: false })(s), undefined);
});

test('a stage wait fails at once when the Issue is closed or has pending, unless pending is allowed', async () => {
  let issues: unknown[] = [];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    'GET /repos/o/exec/issues/6/comments': [{ id: 1, body: '<!-- nibfin:pending -->\nDeliver stopped: the push was rejected (tok-9).', created_at: '', updated_at: '', user: null, html_url: '' }],
  });
  const c = clock();
  const k = new Kit(context(f.github, { secretValues: () => ['tok-9'] }), { now: c.now, sleep: c.sleep });
  const gone = k.stageGone('o/exec', 6, 'deliver');
  issues = [issue(6, { labels: [{ name: 'scope' }, { name: 'pending' }] })];
  const s1 = await k.obs.fresh();
  equal(await gone(s1), '#6 has pending; last Nibfin comment: Deliver stopped: the push was rejected (***).');
  equal(await k.stageGone('o/exec', 6, 'deliver', { allowPending: true })(s1), undefined);
  await rejects(k.obs.until('I\'s deliver job to run', () => undefined, DEADLINE.stage, undefined, { gonePast: gone }), /gave up waiting for I's deliver job to run: #6 has pending/);

  // Closed with delivered ends a stage wait at once; closed without it after a grace period, as Nibfin may label after closing.
  c.advance(MIN);
  issues = [issue(6, { state: 'closed', state_reason: 'completed', closed_at: new Date(c.now()).toISOString(), labels: [{ name: 'delivered' }] })];
  equal(await gone(await k.obs.fresh()), '#6 is closed (completed) with delivered');
  c.advance(MIN);
  issues = [issue(6, { state: 'closed', state_reason: 'not_planned', closed_at: new Date(c.now()).toISOString(), labels: [] })];
  equal(await gone(await k.obs.fresh()), undefined);
  c.advance(2 * MIN);
  equal(await k.closeGone('o/exec', 6)(await k.obs.fresh()), '#6 is closed (not_planned) without delivered');
});

test('a wait with no sandbox activity fails after the stall limit; one with a run in progress or marked quiet does not', async () => {
  let runs = [run(5, 'shape', 'completed', '2026-11-26T10:00:30Z')];
  const f = routes({ ...base, 'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs }), 'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [] }, 'GET /repos/o/exec/issues': [issue(6)] });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const started = c.now();
  await rejects(k.obs.until('I2\'s shape job to run', () => undefined, DEADLINE.stage, k.show('o/exec', 6)), /^Error: no sandbox activity for 20 min while waiting for I2's shape job to run; observed: o\/exec#6 open/);
  equal(c.now() - started, 20 * MIN);

  // A quiet wait runs to its own deadline.
  await rejects(k.obs.until('nothing to happen', () => undefined, 30 * MIN, undefined, { quiet: true }), /^Error: timed out after 30 min waiting for nothing to happen$/);

  // A run in progress is activity, even when no snapshot changes.
  runs = [run(5, 'shape', 'in_progress', '2026-11-26T10:00:30Z')];
  await rejects(k.obs.until('I2\'s shape job to complete', () => undefined, 45 * MIN), /^Error: timed out after 45 min waiting for I2's shape job to complete$/);
});

test('a stall counts from the wait\'s own start, so a wait after a quiet one does not fail at once', async () => {
  const f = routes({ ...base, 'GET /repos/o/exec/actions/runs': { workflow_runs: [] }, 'GET /repos/o/exec/issues': [] });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, stallMs: 20 * MIN });
  await rejects(obs.until('quiet', () => undefined, 25 * MIN, undefined, { quiet: true }), /timed out after 25 min/);
  let polls = 0;
  equal(await obs.until('the third look', () => (++polls === 3 ? true : undefined), 60 * MIN), true);
});

test('an observer wait ends with the abort reason once the run\'s signal aborts', async () => {
  const f = routes({ ...base, 'GET /repos/o/exec/actions/runs': { workflow_runs: [] }, 'GET /repos/o/exec/issues': [] });
  const c = clock();
  const ctl = new AbortController();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, signal: ctl.signal });
  let polls = 0;
  await rejects(obs.until('A to close', () => (++polls === 2 ? (ctl.abort(new Error('harness budget of 190 min ran out')), undefined) : undefined), DEADLINE.delivery), /^Error: harness budget of 190 min ran out$/);
  equal(polls, 2);
  // A sleeping observer wakes on the abort (the real sleep would last a minute).
  const ctl2 = new AbortController();
  const slow = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: () => new Promise(() => {}), signal: ctl2.signal });
  await slow.next();
  const waiting = slow.until('B', () => undefined, DEADLINE.delivery);
  setTimeout(() => ctl2.abort(new Error('budget')), 5);
  await rejects(waiting, /^Error: budget$/);
});

test('interrupted-deliver step 4: two jobs that overlapped on the two Runners pass even when both completed before any snapshot', () => {
  const runners = ['claude-1', 'claude-2'];
  const deliver = job(21, 2, { runner_name: 'claude-1', started_at: '2026-11-26T10:00:00Z', completed_at: '2026-11-26T10:30:00Z' });
  const shape = job(31, 3, { runner_name: 'claude-2', started_at: '2026-11-26T10:10:00Z', completed_at: '2026-11-26T10:12:00Z' });
  const w = (j: Job, stage: 'deliver' | 'shape') => jobWindow(j, issueKey('o/exec', j.id), stage) as NonNullable<ReturnType<typeof jobWindow>>;
  deepEqual(busyTogether([w(deliver, 'deliver'), w(shape, 'shape')], runners), { start: Date.parse('2026-11-26T10:10:00Z'), end: Date.parse('2026-11-26T10:12:00Z') });
  equal(busyGone(deliver, shape, runners), undefined);
  // Still running: the window ends at Infinity and still counts.
  const running = { ...shape, status: 'in_progress', completed_at: null };
  deepEqual(busyTogether([w(deliver, 'deliver'), w(running, 'shape')], runners)?.end, Date.parse('2026-11-26T10:30:00Z'));

  // Sequential windows, the same Runner, or other Runners registered do not count.
  const after = { ...shape, started_at: '2026-11-26T10:31:00Z', completed_at: '2026-11-26T10:40:00Z' };
  equal(busyTogether([w(deliver, 'deliver'), w(after, 'shape')], runners), undefined);
  const same = { ...shape, runner_name: 'claude-1' };
  equal(busyTogether([w(deliver, 'deliver'), w(same, 'shape')], runners), undefined);
  equal(busyTogether([w(deliver, 'deliver'), w(shape, 'shape')], [...runners, 'claude-3']), undefined);
  equal(busyGone(deliver, after, runners), "I's deliver job 21 completed at 2026-11-26T10:30:00Z before I2's shape job started");
  equal(busyGone(deliver, undefined, runners), "I's deliver job 21 completed at 2026-11-26T10:30:00Z before I2's shape job started");
  equal(busyGone(deliver, same, runners), "I2's shape job 31 ran on claude-1, the same Runner as I's deliver job 21");
  equal(busyGone(deliver, shape, ['claude-1']), "the registered Runners are claude-1; I's deliver job and I2's shape job cannot cover them");
  // While I's job runs and I2's has not started, the goal is still in reach.
  equal(busyGone({ ...deliver, status: 'in_progress', completed_at: null }, undefined, runners), undefined);
});

test('interrupted-deliver step 5: a queued job counts when the jobs\' own windows cover every Runner at the snapshot', () => {
  const runners = ['claude-1', 'claude-2'];
  const deliver = job(21, 2, { runner_name: 'claude-1', started_at: '2026-11-26T10:00:00Z', completed_at: null, status: 'in_progress' });
  const shape = job(31, 3, { runner_name: 'claude-2', started_at: '2026-11-26T10:10:00Z', completed_at: '2026-11-26T10:12:00Z' });
  equal(allBusyAt(Date.parse('2026-11-26T10:11:00Z'), [deliver, shape], runners), true);
  equal(allBusyAt(Date.parse('2026-11-26T10:13:00Z'), [deliver, shape], runners), false);
  equal(allBusyAt(Date.parse('2026-11-26T10:11:00Z'), [deliver, shape], []), false);
});

test('a wait is not judged on a snapshot taken before it began, such as one still showing the harness\'s own pending', async () => {
  let labels = [{ name: 'scope' }, { name: 'pending' }];
  let state = 'open';
  const f = routes({ ...base, 'GET /repos/o/exec/actions/runs': { workflow_runs: [] }, 'GET /repos/o/exec/issues': () => [issue(6, { labels, state, closed_at: state === 'closed' ? '2026-11-26T10:01:00Z' : null })] });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await k.obs.next();
  // The harness removes pending; the cached snapshot still shows it.
  labels = [{ name: 'scope' }];
  let polls = 0;
  const closed = await k.obs.until(
    'P to close with delivered',
    (s) => {
      if (++polls === 1) {
        state = 'closed';
        labels = [{ name: 'delivered' }];
      }
      return k.delivered(s, 'o/exec', 6);
    },
    DEADLINE.delivery,
    undefined,
    { gonePast: k.closeGone('o/exec', 6) },
  );
  equal(closed.number, 6);
  equal(polls, 2);
});
