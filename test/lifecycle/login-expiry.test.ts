// login-expiry after the re-login (Issue #585): R1.12 is judged by the redone shape run's
// agent job, and a `pause` or `pending` the scenario did not add ends its waits at once.
import { equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../../scenarios/lifecycle/analysis.ts';
import { DEADLINE, Kit, STALL } from '../../scenarios/lifecycle/kit.ts';
import type { Snapshot } from '../../scenarios/lifecycle/observe.ts';
import { foreignLabelGone, redoneShapeProblem } from '../../scenarios/lifecycle/phase1.ts';
import { clock, context, routes } from './fake.ts';

const MIN = 60_000;
const base = {
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /repos/o/exec/pulls': [],
  'GET /rate_limit': {},
};
const shapeRun = {
  id: 5,
  display_title: 'Nibfin · o/exec#6 · shape',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-26T10:00:30Z',
  name: 'Nibfin',
  event: 'workflow_dispatch',
  head_sha: 'h',
};
const job = (id: number, extra: Partial<Job> = {}): Job => ({
  id,
  run_id: 5,
  name: 'stage',
  status: 'completed',
  conclusion: 'success',
  labels: ['self-hosted', 'nibfin-1'],
  runner_name: 'claude-1',
  created_at: '2026-11-26T10:00:40Z',
  started_at: '2026-11-26T10:00:50Z',
  completed_at: '2026-11-26T10:02:00Z',
  ...extra,
});
const labeled = (name: string, at: string, login: string | null) => ({
  event: 'labeled',
  created_at: at,
  label: { name },
  actor: login === null ? null : { login },
});
const comment = {
  id: 1,
  body: '<!-- nibfin:pending -->\nShape stopped: log in again with `claude /login`.',
  created_at: '',
  updated_at: '',
  user: null,
  html_url: 'https://github.com/o/exec/issues/6#issuecomment-1',
};

/** A Kit over an Issue #6 with the given labels and timeline, `woke` being when the scenario removed `pending`. */
function setup(labels: () => string[], timeline: () => unknown[]) {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [shapeRun] },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [job(11)] },
    'GET /repos/o/exec/issues': () => [
      { number: 6, title: 't', state: 'open', labels: labels().map((name) => ({ name })) },
    ],
    'GET /repos/o/exec/issues/6/comments': [comment],
    'GET /repos/o/exec/issues/6/timeline': () => timeline(),
  });
  const c = clock();
  const k = new Kit(context(f.github, { secretValues: () => ['tok-9'] }), { now: c.now, sleep: c.sleep });
  const woke = c.now();
  const foreign = foreignLabelGone(k, 'o/exec', 6, woke);
  const gone = k.stageGone('o/exec', 6, 'shape', { since: woke - MIN, publishes: 'shaped' });
  const exit = async (s: Snapshot) => (await foreign(s)) ?? (await gone(s));
  return { c, k, woke, exit, foreign };
}

test('a pause another actor added ends the `shaped` wait at once, naming the label, its time, the actor and the last Nibfin comment', async () => {
  const { c, k, exit } = setup(
    () => ['scope', 'pause'],
    () => [
      labeled('pending', '2026-11-26T09:50:00Z', 'nibfin-bot'),
      labeled('pause', '2026-11-26T10:00:20Z', 'someone-else'),
    ],
  );
  const started = c.now();
  await rejects(
    k.obs.until(
      '`shaped`',
      (s) => (k.labels(s, 'o/exec', 6).includes('shaped') ? true : undefined),
      DEADLINE.event,
      k.show('o/exec', 6),
      { gonePast: exit },
    ),
    /^Error: gave up waiting for `shaped`: #6 gained pause at 2026-11-26T10:00:20\.000Z by someone-else, which the scenario did not add; observed: o\/exec#6 open \[scope, pause\] .*last Nibfin comment: https:\/\/github\.com\/o\/exec\/issues\/6#issuecomment-1$/,
  );
  equal(c.now() - started < STALL, true, 'it ended long before the stall limit');
  equal(c.now() - started < 3 * MIN, true, 'it ended on the first judged snapshot');
});

test('a pause not yet on the timeline ends the wait one snapshot later, by an actor not yet on the timeline; a missing actor is unknown', async () => {
  const { c, k, exit } = setup(
    () => ['scope', 'pause'],
    () => [],
  );
  const started = c.now();
  await rejects(
    k.obs.until('the redone shape run to complete', () => undefined, DEADLINE.stage, k.show('o/exec', 6), {
      gonePast: exit,
    }),
    /^Error: gave up waiting for the redone shape run to complete: #6 gained pause, first seen at \S+, by an actor not yet on the timeline, which the scenario did not add; observed:/,
  );
  equal(c.now() - started < STALL, true, 'it ended long before the stall limit');

  const t = setup(
    () => ['scope', 'pause'],
    () => [labeled('pause', '2026-11-26T10:00:20Z', null)],
  );
  equal(
    await t.foreign(await t.k.obs.fresh()),
    '#6 gained pause at 2026-11-26T10:00:20.000Z by unknown, which the scenario did not add',
  );
});

test("a pending added after the re-login is named with its time and actor; an older pending keeps stageGone's reason", async () => {
  const fresh = setup(
    () => ['scope', 'pending'],
    () => [labeled('pending', '2026-11-26T10:00:00Z', 'someone-else')],
  );
  equal(
    await fresh.exit(await fresh.k.obs.fresh()),
    '#6 has pending, added at 2026-11-26T10:00:00.000Z by someone-else',
  );

  const old = setup(
    () => ['scope', 'pending'],
    () => [labeled('pending', '2026-11-26T09:59:59Z', 'nibfin-bot')],
  );
  const s = await old.k.obs.fresh();
  equal(await old.foreign(s), undefined);
  match((await old.exit(s)) ?? '', /^#6 has pending; last Nibfin comment: Shape stopped: log in again/);
});

test('R1.12 counts only a self-hosted agent job that ran on a Runner and succeeded', () => {
  const run = { id: 5, conclusion: 'success' };
  const hosted = job(10, { name: 'route', labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 3' });
  const notRun = job(11, { status: 'completed', conclusion: 'skipped', runner_name: null, started_at: null });
  equal(
    redoneShapeProblem(run, [hosted, notRun]),
    'the redone shape run 5 concluded success with no agent job that ran on a Runner; jobs: route (runner GitHub Actions 3, completed/success); stage (runner none, completed/skipped)',
  );
  equal(
    redoneShapeProblem(run, []),
    'the redone shape run 5 concluded success with no agent job that ran on a Runner; jobs: none',
  );
  equal(
    redoneShapeProblem({ id: 5, conclusion: 'failure' }, [hosted, job(12, { conclusion: 'failure' })]),
    'the redone shape run 5 (failure): its agent job 12 concluded failure',
  );
  equal(redoneShapeProblem(run, [hosted, job(12)]), undefined);
});

test('a redone run with a successful agent job, then shaped without pause, passes the wait', async () => {
  let labels = ['scope'];
  const { k, exit } = setup(
    () => labels,
    () => [],
  );
  equal(redoneShapeProblem(shapeRun, await k.obs.jobs('o/exec', 5)), undefined);
  let polls = 0;
  const ok = await k.obs.until(
    '`shaped`',
    (s) => {
      if (++polls === 2) labels = ['scope', 'shaped'];
      return k.labels(s, 'o/exec', 6).includes('shaped') ? true : undefined;
    },
    DEADLINE.event,
    k.show('o/exec', 6),
    { gonePast: exit },
  );
  equal(ok, true);
});
