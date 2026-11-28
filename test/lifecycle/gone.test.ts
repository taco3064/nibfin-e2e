// Waits that end early (Issue #334): a goal out of reach, a stall, an abort; and the
// deterministic Runner-busy checks of interrupted-deliver.
import { equal, match, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../../scenarios/lifecycle/analysis.ts';
import { DEADLINE, Kit, PUBLISH_GRACE, QUOTE_LIMIT, STALL } from '../../scenarios/lifecycle/kit.ts';
import { Observer } from '../../scenarios/lifecycle/observe.ts';
import { activeRunner, allBusyAt, i3Missed } from '../../scenarios/lifecycle/phase1.ts';
import { clock, context, routes } from './fake.ts';

const MIN = 60_000;
/** Why a test wait names no Issue: it exercises the wait itself (stall, abort, deadline). */
const NO_ISSUE = 'the test exercises the wait itself';
const base = {
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /repos/o/exec/pulls': [],
  'GET /rate_limit': {},
};
// The Issue's events: `pending` added past REPAIR_GRACE before the fake clock's start,
// so a `pending` with no repair record ends a wait at once.
const pendingAt = '2026-11-26T09:45:00Z';
const pendingEvents = {
  'GET /repos/o/exec/issues/6/events': [{ event: 'labeled', created_at: pendingAt, label: { name: 'pending' } }],
};
/** The part of a pending reason saying no repair record was written; `min` defaults to any count. */
const noRecord = (min?: number) =>
  `; no repair record ${min ?? '\\d+'} min after pending was added at ${new Date(pendingAt).toISOString()}`;
const run = (id: number, stage: string, status: string, created: string, n = 6) => ({
  id,
  display_title: `Nibfin · o/exec#${n} · ${stage}`,
  status,
  conclusion: status === 'completed' ? 'success' : null,
  created_at: created,
  name: 'Nibfin',
  event: 'workflow_dispatch',
  head_sha: 'h',
});
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
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: 't',
  state: 'open',
  labels: [{ name: 'scope' }],
  ...extra,
});

test('a stage wait fails on the first snapshot showing the stage job completed and another stage followed, long before its deadline', async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [
        run(5, 'shape', 'completed', '2026-11-26T10:00:30Z'),
        run(7, 'deliver', 'in_progress', '2026-11-26T10:21:00Z'),
      ],
    },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [job(11, 5)] },
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }] })],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const started = c.now();
  await rejects(
    k.obs.until("I2's shape job to run", () => undefined, DEADLINE.stage, k.show('o/exec', 6), {
      ...k.about('o/exec', 6),
      gonePast: k.stageGone('o/exec', 6, 'shape'),
    }),
    /^Error: gave up waiting for I2's shape job to run: #6's shape job 11 completed \(run 5, success\) and a deliver run 7 followed; observed: o\/exec#6 open \[scope, shaped\]/,
  );
  equal(c.now() - started < MIN, true, 'it ended on the first snapshot');
});

test('a completed stage job is not out of reach while no other stage followed, nor when it is older than the wait', async () => {
  const runs = [
    run(5, 'shape', 'completed', '2026-11-26T09:00:00Z'),
    run(7, 'deliver', 'completed', '2026-11-26T09:30:00Z'),
    run(9, 'shape', 'completed', '2026-11-26T10:00:30Z'),
  ];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: runs },
    'GET /repos/o/exec/actions/runs/5/jobs': {
      jobs: [job(11, 5, { created_at: '2026-11-26T09:00:10Z', completed_at: '2026-11-26T09:20:00Z' })],
    },
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/actions/runs/9/jobs': { jobs: [job(12, 9)] },
    'GET /repos/o/exec/issues': [issue(6)],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const s = await k.obs.next();
  // Job 11 completed before the wait and was followed by deliver 7; job 12 completed with nothing after it.
  equal(await k.stageGone('o/exec', 6, 'shape')(s), undefined);
  match(
    (await k.stageGone('o/exec', 6, 'shape', { since: Date.parse('2026-11-26T08:00:00Z') })(s)) ?? '',
    /shape job 11 completed \(run 5, success\) and a deliver run 7 followed/,
  );
  equal(
    await k.stageGone('o/exec', 6, 'shape', { since: Date.parse('2026-11-26T08:00:00Z'), jobs: false })(s),
    undefined,
  );
});

test('with publishes, a stage wait fails once a successful job of the stage left the Issue without its label past the grace (Issue #463)', async () => {
  const shapeJob = (extra: Partial<Job> = {}) =>
    job(11, 5, { created_at: '2026-11-26T10:00:40Z', completed_at: '2026-11-26T10:02:00Z', ...extra });
  // A fresh Kit per case: the observer keeps a completed run's jobs once read.
  const setup = (jobs: Job[], labels = [{ name: 'scope' }, { name: 'pause' }]) => {
    const f = routes({
      ...base,
      'GET /repos/o/exec/actions/runs': { workflow_runs: [run(5, 'shape', 'completed', '2026-11-26T10:00:30Z')] },
      'GET /repos/o/exec/actions/runs/5/jobs': { jobs },
      'GET /repos/o/exec/issues': [issue(6, { labels })],
    });
    const c = clock();
    return { c, k: new Kit(context(f.github), { now: c.now, sleep: c.sleep }) };
  };
  const since = Date.parse('2026-11-26T10:00:00Z');

  const { c, k } = setup([shapeJob()]);
  const started = c.now();
  await rejects(
    k.obs.until('`shaped`', () => undefined, DEADLINE.event, k.show('o/exec', 6), {
      ...k.about('o/exec', 6),
      // The fixture's pause stands for one a paused Issue has; this test judges only the publishes exit.
      expects: { pause: 'the fixture is paused on purpose' },
      gonePast: k.stageGone('o/exec', 6, 'shape', { since, publishes: 'shaped' }),
    }),
    /^Error: gave up waiting for `shaped`: #6's shape job 11 completed \(run 5, success\) and #6 has no shaped [5-9] min later \(labels: scope, pause\)/,
  );
  equal(c.now() - started < STALL, true, 'it ended long before the stall check');
  equal(c.now() - Date.parse('2026-11-26T10:02:00Z') >= PUBLISH_GRACE, true, 'it waited out the grace');

  // Past the grace, only a successful job inside `since`, a missing label and `publishes` with jobs end the wait.
  const late = async (jobs: Job[], opts: Parameters<Kit['stageGone']>[3], labels?: { name: string }[]) => {
    const t = setup(jobs, labels);
    t.c.advance(10 * MIN);
    return t.k.stageGone('o/exec', 6, 'shape', opts)(await t.k.obs.fresh());
  };
  match(
    (await late([shapeJob()], { since, publishes: 'shaped' })) ?? '',
    /^#6's shape job 11 completed \(run 5, success\) and #6 has no shaped 8 min later \(labels: scope, pause\)$/,
  );
  equal(
    await late([shapeJob({ completed_at: '2026-11-26T10:06:00Z' })], { since, publishes: 'shaped' }),
    undefined,
    'within the grace',
  );
  equal(
    await late([shapeJob()], { since, publishes: 'shaped' }, [{ name: 'scope' }, { name: 'shaped' }]),
    undefined,
    'shaped is on the Issue',
  );
  equal(await late([shapeJob({ conclusion: 'failure' })], { since, publishes: 'shaped' }), undefined, 'the job failed');
  equal(
    await late([shapeJob()], { since: Date.parse('2026-11-26T10:01:00Z'), publishes: 'shaped' }),
    undefined,
    'the job is older than the wait',
  );
  equal(await late([shapeJob()], { since }), undefined, 'publishes is unset');
  equal(await late([shapeJob()], { since, publishes: 'shaped', jobs: false }), undefined, 'jobs: false');
});

test('a stage wait fails at once when the Issue is closed or has pending, unless pending is allowed', async () => {
  let issues: unknown[] = [];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    ...pendingEvents,
    'GET /repos/o/exec/issues/6/comments': [
      {
        id: 1,
        body: '<!-- nibfin:pending -->\nDeliver stopped: the push was rejected (tok-9).',
        created_at: '',
        updated_at: '',
        user: null,
        html_url: '',
      },
    ],
  });
  const c = clock();
  const k = new Kit(context(f.github, { secretValues: () => ['tok-9'] }), { now: c.now, sleep: c.sleep });
  const gone = k.stageGone('o/exec', 6, 'deliver');
  issues = [issue(6, { labels: [{ name: 'scope' }, { name: 'pending' }] })];
  const s1 = await k.obs.fresh();
  equal(await gone(s1), `#6 has pending${noRecord(15)}; last Nibfin comment: Deliver stopped: the push was rejected (***).`);
  equal(await k.stageGone('o/exec', 6, 'deliver', { allowPending: true })(s1), undefined);
  await rejects(
    k.obs.until("I's deliver job to run", () => undefined, DEADLINE.stage, undefined, { ...k.about('o/exec', 6), gonePast: gone }),
    new RegExp(`gave up waiting for I's deliver job to run: #6 has pending${noRecord()}; last Nibfin comment`),
  );

  // Closed with delivered ends a stage wait at once; closed without it after a grace period, as Nibfin may label after closing.
  c.advance(MIN);
  issues = [
    issue(6, {
      state: 'closed',
      state_reason: 'completed',
      closed_at: new Date(c.now()).toISOString(),
      labels: [{ name: 'delivered' }],
    }),
  ];
  equal(await gone(await k.obs.fresh()), '#6 is closed (completed) with delivered');
  c.advance(MIN);
  issues = [
    issue(6, { state: 'closed', state_reason: 'not_planned', closed_at: new Date(c.now()).toISOString(), labels: [] }),
  ];
  equal(await gone(await k.obs.fresh()), undefined);
  c.advance(2 * MIN);
  equal(await k.closeGone('o/exec', 6)(await k.obs.fresh()), '#6 is closed (not_planned) without delivered');
});

test('a wait with no sandbox activity fails after the stall limit; one with a run in progress or marked quiet does not', async () => {
  let runs: (ReturnType<typeof run> & { run_attempt?: number })[] = [run(5, 'shape', 'completed', '2026-11-26T10:00:30Z')];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs }),
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue(6)],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const started = c.now();
  await rejects(
    k.obs.until("I2's shape job to run", () => undefined, DEADLINE.stage, k.show('o/exec', 6), { noIssue: NO_ISSUE }),
    /^Error: no sandbox activity for 20 min while waiting for I2's shape job to run; observed: o\/exec#6 open/,
  );
  equal(c.now() - started, 20 * MIN);

  // A quiet wait runs to its own deadline.
  await rejects(
    k.obs.until('nothing to happen', () => undefined, 30 * MIN, undefined, { noIssue: NO_ISSUE, quiet: true }),
    /^Error: timed out after 30 min waiting for nothing to happen$/,
  );

  // A run in progress is activity, even when no snapshot changes. It is a re-run: the
  // observer keeps a completed attempt over an unfinished read of the same attempt.
  runs = [{ ...run(5, 'shape', 'in_progress', '2026-11-26T10:00:30Z'), run_attempt: 2 }];
  await rejects(
    k.obs.until("I2's shape job to complete", () => undefined, 45 * MIN, undefined, { noIssue: NO_ISSUE }),
    /^Error: timed out after 45 min waiting for I2's shape job to complete$/,
  );
});

test("a stall counts from the wait's own start, so a wait after a quiet one does not fail at once", async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [],
  });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, stallMs: 20 * MIN });
  await rejects(
    obs.until('quiet', () => undefined, 25 * MIN, undefined, { noIssue: NO_ISSUE, quiet: true }),
    /timed out after 25 min/,
  );
  let polls = 0;
  equal(await obs.until('the third look', () => (++polls === 3 ? true : undefined), 60 * MIN, undefined, { noIssue: NO_ISSUE }), true);
});

test("an observer wait ends with the abort reason once the run's signal aborts", async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [],
  });
  const c = clock();
  const ctl = new AbortController();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, signal: ctl.signal });
  let polls = 0;
  await rejects(
    obs.until(
      'A to close',
      () => (++polls === 2 ? (ctl.abort(new Error('harness budget of 190 min ran out')), undefined) : undefined),
      DEADLINE.delivery,
      undefined,
      { noIssue: NO_ISSUE },
    ),
    /^Error: harness budget of 190 min ran out$/,
  );
  equal(polls, 2);
  // A sleeping observer wakes on the abort (the real sleep would last a minute).
  const ctl2 = new AbortController();
  const slow = new Observer(f.github, ['o/exec'], {
    since: c.now(),
    now: c.now,
    sleep: () => new Promise(() => {}),
    signal: ctl2.signal,
  });
  await slow.next();
  const waiting = slow.until('B', () => undefined, DEADLINE.delivery, undefined, { noIssue: NO_ISSUE });
  setTimeout(() => ctl2.abort(new Error('budget')), 5);
  await rejects(waiting, /^Error: budget$/);
});

test("interrupted-deliver step 5: I's deliver job alone on the one active Runner counts as every active Runner busy while it runs", () => {
  const runners = ['claude-1'];
  const deliver = job(21, 2, {
    runner_name: 'claude-1',
    started_at: '2026-11-26T10:00:00Z',
    completed_at: '2026-11-26T10:30:00Z',
  });
  equal(allBusyAt(Date.parse('2026-11-26T10:11:00Z'), [deliver], runners), true);
  // Still running: its window ends at Infinity.
  const running = { ...deliver, status: 'in_progress', completed_at: null };
  equal(allBusyAt(Date.parse('2026-11-26T11:00:00Z'), [running], runners), true);
  // After it completed, with a second Runner to cover, or with no Runner, it does not count.
  equal(allBusyAt(Date.parse('2026-11-26T10:31:00Z'), [deliver], runners), false);
  equal(allBusyAt(Date.parse('2026-11-26T10:11:00Z'), [deliver], ['claude-1', 'claude-2']), false);
  equal(allBusyAt(Date.parse('2026-11-26T10:11:00Z'), [deliver], []), false);
});

test("interrupted-deliver step 5: I's deliver job completing before I3's shape job was seen queued names both jobs", () => {
  const at = Date.parse('2026-11-26T10:31:00Z');
  const running = job(21, 2, { status: 'in_progress', started_at: '2026-11-26T10:00:00Z', completed_at: null });
  equal(i3Missed(running, undefined, at), undefined);
  const deliver = { ...running, status: 'completed', completed_at: '2026-11-26T10:30:00Z' };
  const head = "I's deliver job 21 completed at 2026-11-26T10:30:00Z before I3's shape job was seen queued while it ran; ";
  equal(i3Missed(deliver, undefined, at), `${head}I3's shape job was not yet seen when read at 2026-11-26T10:31:00.000Z`);
  const queued = job(31, 3, { status: 'queued', conclusion: null, runner_name: null, created_at: '2026-11-26T10:29:00Z', started_at: null, completed_at: null });
  equal(
    i3Missed(deliver, queued, at),
    `${head}I3's shape job 31 was queued (created 2026-11-26T10:29:00Z) when read at 2026-11-26T10:31:00.000Z`,
  );
  const started = { ...queued, status: 'in_progress', runner_name: 'claude-1', started_at: '2026-11-26T10:30:10Z' };
  equal(
    i3Missed(deliver, started, at),
    `${head}I3's shape job 31 was in_progress, started at 2026-11-26T10:30:10Z on claude-1, when read at 2026-11-26T10:31:00.000Z`,
  );
  const done = { ...started, status: 'completed', conclusion: 'success', completed_at: '2026-11-26T10:30:50Z' };
  equal(
    i3Missed(deliver, done, at),
    `${head}I3's shape job 31 had started at 2026-11-26T10:30:10Z on claude-1 and completed at 2026-11-26T10:30:50Z when read at 2026-11-26T10:31:00.000Z`,
  );
});

test('interrupted-deliver: exactly one registration of the active slot is required, and any other read names every registration', () => {
  const r = (id: number, name: string, status = 'online', busy = false) => ({ id, name, status, busy });
  equal(activeRunner([r(1, 'h-1a2b-claude-1'), r(2, 'h-1a2b-claude-2', 'online')]), 'h-1a2b-claude-1');
  throws(
    () => activeRunner([r(2, 'h-1a2b-claude-2', 'offline', true)]),
    {
      message:
        'interrupted-deliver needs exactly one active Runner (claude-1); the registrations read are h-1a2b-claude-2 (slot claude-2, offline, busy)',
    },
  );
  throws(() => activeRunner([]), /the registrations read are none$/);
  throws(
    () => activeRunner([r(1, 'a-claude-1'), r(3, 'b-claude-1'), r(4, 'other')]),
    /are a-claude-1 \(slot claude-1, online, idle\), b-claude-1 \(slot claude-1, online, idle\), other \(slot none, online, idle\)$/,
  );
});

test("a wait is not judged on a snapshot taken before it began, such as one still showing the harness's own pending", async () => {
  let labels = [{ name: 'scope' }, { name: 'pending' }];
  let state = 'open';
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => [
      issue(6, { labels, state, closed_at: state === 'closed' ? '2026-11-26T10:01:00Z' : null }),
    ],
  });
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
    { ...k.about('o/exec', 6), gonePast: k.closeGone('o/exec', 6) },
  );
  equal(closed.number, 6);
  equal(polls, 2);
});

test('failed reads do not count as calm: the stall limit counts from the last failed refresh', async () => {
  const c = clock();
  const started = c.now();
  // Reads fail from the 1st to the 30th minute.
  const failing = () => c.now() - started >= MIN && c.now() - started < 30 * MIN;
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => (failing() ? { status: 502, data: { message: 'Bad Gateway' } } : { data: [] }),
  });
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, stallMs: 20 * MIN });
  await rejects(
    obs.until('A to close', () => undefined, DEADLINE.delivery, undefined, { noIssue: NO_ISSUE }),
    /^Error: no sandbox activity for 20 min while waiting for A to close/,
  );
  const took = (c.now() - started) / MIN;
  equal(took >= 49 && took <= 51, true, `failed after ${took} min`);
});

// Issue #569: the stall check fails only on a recent snapshot judged by gonePast.
const blockedComment = [
  {
    id: 1,
    body: '<!-- nibfin:pending -->\nNibfin stopped and needs a person. - Code: STAGE_BLOCKED',
    created_at: '',
    updated_at: '',
    user: null,
    html_url: '',
  },
];
const pendingIssue = () => [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }, { name: 'pending' }] })];

test('a wait whose first pass blocks past the stall limit while the Issue gets pending ends with that reason, not on the stall check', async () => {
  let issues: unknown[] = [issue(6)];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    'GET /repos/o/exec/issues/6/comments': blockedComment,
    ...pendingEvents,
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  let polls = 0;
  await rejects(
    k.obs.until(
      'a marked review comment',
      () => {
        if (++polls === 1) {
          c.advance(STALL + 5 * MIN);
          issues = pendingIssue();
        }
        return undefined;
      },
      DEADLINE.stage,
      k.show('o/exec', 6),
      { ...k.about('o/exec', 6), gonePast: k.closeGone('o/exec', 6) },
    ),
    new RegExp(
      `^Error: gave up waiting for a marked review comment: #6 has pending${noRecord()}; last Nibfin comment: Nibfin stopped and needs a person\\. - Code: STAGE_BLOCKED`,
    ),
  );
  equal(polls, 1);
});

test("a refresh inside a blocked pass does not stand in for the stall decision's own read", async () => {
  let issues: unknown[] = [issue(6)];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    'GET /repos/o/exec/issues/6/comments': blockedComment,
    ...pendingEvents,
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  let polls = 0;
  await rejects(
    k.obs.until(
      'a marked review comment',
      async () => {
        if (++polls === 1) {
          await k.obs.fresh();
          c.advance(STALL + 5 * MIN);
          issues = pendingIssue();
        }
        return undefined;
      },
      DEADLINE.stage,
      undefined,
      { ...k.about('o/exec', 6), gonePast: k.closeGone('o/exec', 6) },
    ),
    new RegExp(
      `^Error: gave up waiting for a marked review comment: #6 has pending${noRecord()}; last Nibfin comment: Nibfin stopped and needs a person\\. - Code: STAGE_BLOCKED`,
    ),
  );
});

test('an observer read blocked on a peer request does not count as recent for the stall check', async () => {
  let issues: unknown[] = [issue(6)];
  let peerReads = 0;
  const c = clock();
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    'GET /repos/o/exec/issues/6/comments': blockedComment,
    ...pendingEvents,
    // The wait's first read lists the exec issues, then blocks on the peer's while F gets pending.
    'GET /repos/o/peer/issues': () => {
      if (++peerReads === 2) {
        c.advance(STALL + 5 * MIN);
        issues = pendingIssue();
      }
      return [];
    },
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await k.obs.next();
  await rejects(
    k.obs.until('a marked review comment', () => undefined, DEADLINE.stage, undefined, {
      ...k.about('o/exec', 6),
      gonePast: k.closeGone('o/exec', 6),
    }),
    new RegExp(
      `^Error: gave up waiting for a marked review comment: #6 has pending${noRecord()}; last Nibfin comment: Nibfin stopped and needs a person\\. - Code: STAGE_BLOCKED`,
    ),
  );
  equal(peerReads >= 3, true, 'the decision read anew');
});

test('a blocked pass with no gonePast reason and no activity still fails on the stall check', async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [issue(6)],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const started = c.now();
  let polls = 0;
  const block = () => {
    if (++polls === 1) c.advance(STALL + 5 * MIN);
    return undefined;
  };
  await rejects(
    k.obs.until('a marked review comment', block, DEADLINE.stage, undefined, { ...k.about('o/exec', 6), gonePast: k.closeGone('o/exec', 6) }),
    /^Error: no sandbox activity for 25 min while waiting for a marked review comment$/,
  );
  equal(c.now() - started, STALL + 5 * MIN);
  // Without gonePast too.
  polls = 0;
  await rejects(k.obs.until('B', block, DEADLINE.stage, undefined, { noIssue: NO_ISSUE }), /^Error: no sandbox activity for 25 min while waiting for B$/);
});

// The pending reason keeps the whole stop reason; summary keeps a short form (Issue #597).
const stopUrl = 'https://github.com/o/exec/issues/6#issuecomment-9';
const blockedUrl = 'https://github.com/o/exec/pull/41#discussion_r1234567890';
const stopBody = (reason: string) =>
  `<!-- nibfin:pending -->\nNibfin stopped and needs a person.\n\n- Code: STAGE_BLOCKED\n- Run: https://github.com/o/exec/actions/runs/46027033527\n\n\`\`\`text\n${reason}\n\`\`\``;
const fenced = `Writer returned blocked (${blockedUrl}): ${'the rebase onto main conflicts in src/app.ts and the other side cannot hold; '.repeat(5)}see ${blockedUrl}`;
const collapse = (body: string) =>
  body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stopKit(body: string, secrets: string[] = []) {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': pendingIssue(),
    ...pendingEvents,
    'GET /repos/o/exec/issues/6/comments': [
      { id: 9, body, created_at: '', updated_at: '', user: null, html_url: stopUrl },
    ],
  });
  const c = clock();
  return new Kit(context(f.github, { secretValues: () => secrets }), { now: c.now, sleep: c.sleep });
}

test('a stop comment of about 600 characters appears in the pending reason in full, the fenced reason and its final URL included', async () => {
  const body = stopBody(fenced);
  const text = collapse(body);
  equal(text.length > 550 && text.length < 700, true, `the comment is about 600 characters (${text.length})`);
  const k = stopKit(body);
  const s = await k.obs.next();
  const reason = await k.stageGone('o/exec', 6, 'shape')(s);
  equal(reason, `#6 has pending${noRecord(15)}; last Nibfin comment: ${text}`);
  equal(reason?.endsWith(`see ${blockedUrl} \`\`\``), true);
  equal(await k.closeGone('o/exec', 6)(s), reason);
  await rejects(
    k.obs.until('a marked review comment', () => undefined, DEADLINE.stage, undefined, {
      ...k.about('o/exec', 6),
      gonePast: k.closeGone('o/exec', 6),
    }),
    new RegExp(
      `^Error: gave up waiting for a marked review comment: #6 has pending${noRecord()}; last Nibfin comment: ${escape(text)}$`,
    ),
  );
});

test('a stop comment over the limit is cut at its end on a whole token, with the dropped count and the comment URL', async () => {
  const body = stopBody(`Writer returned blocked: ${'conflicting-requirement '.repeat(80)}see ${blockedUrl}`);
  const text = collapse(body);
  equal(text.length > QUOTE_LIMIT, true);
  const k = stopKit(body);
  const reason = (await k.stageGone('o/exec', 6, 'shape')(await k.obs.next())) ?? '';
  const m = new RegExp(
    `^#6 has pending${noRecord()}; last Nibfin comment: (.*) … \\(cut, (\\d+) more characters; full comment: (\\S+)\\)$`,
  ).exec(reason);
  equal(!!m, true, reason);
  const [, kept = '', dropped = '', url = ''] = m ?? [];
  equal(url, stopUrl);
  equal(kept.length <= QUOTE_LIMIT, true);
  equal(text.startsWith(kept), true, 'the kept part is the start of the comment');
  equal(text[kept.length], ' ', 'the cut falls on a whole token');
  equal(Number(dropped), text.length - kept.length);
  match(kept, /Code: STAGE_BLOCKED - Run: https:\/\/github\.com\/o\/exec\/actions\/runs\/46027033527 /);
});

test('a secret inside the stop comment is masked in every quote, also one across the cut', async () => {
  const head = stopBody('Writer returned blocked: tok-in-text ');
  const pad = 'x'.repeat(QUOTE_LIMIT - collapse(head).length - 3);
  const body = `${head.slice(0, -4)}${pad}secret-across-the-cut and more text\n\`\`\``;
  const text = collapse(body);
  const at = text.indexOf('secret-across-the-cut');
  equal(at < QUOTE_LIMIT && at + 'secret-across-the-cut'.length > QUOTE_LIMIT, true, 'the secret straddles the limit');
  const k = stopKit(body, ['tok-in-text', 'secret-across-the-cut']);
  const s = await k.obs.next();
  for (const out of [
    await k.stageGone('o/exec', 6, 'shape')(s),
    await k.summary(s, 'o/exec', 6, { full: true }),
    await k.summary(s, 'o/exec', 6),
  ]) {
    for (const part of ['tok-in-text', 'tok-in', 'secret-across', 'across-the-cut'])
      equal(out?.includes(part), false, `${part} in ${out}`);
  }
  match((await k.stageGone('o/exec', 6, 'shape')(s)) ?? '', /blocked: \*\*\* x/);
});

test("summary shows the stop comment's code and run link but not its reason; with full it shows the whole comment", async () => {
  const body = stopBody(fenced);
  const k = stopKit(body);
  const s = await k.obs.next();
  const short = await k.summary(s, 'o/exec', 6);
  equal(
    short,
    'o/exec#6 open [scope, shaped, pending] runs: none; last Nibfin comment: Code: STAGE_BLOCKED, Run: https://github.com/o/exec/actions/runs/46027033527',
  );
  equal(await k.show('o/exec', 6)(s), short);
  equal(
    await k.summary(s, 'o/exec', 6, { full: true }),
    `o/exec#6 open [scope, shaped, pending] runs: none; last Nibfin comment: ${collapse(body)}`,
  );
  const plain = stopKit('<!-- nibfin:pending -->\nShape stopped: log in again.');
  equal(
    await plain.summary(await plain.obs.next(), 'o/exec', 6),
    `o/exec#6 open [scope, shaped, pending] runs: none; last Nibfin comment: ${stopUrl}`,
  );
});

test('a wait ended by pending holds the stop reason once: in the reason, not again in the observed part', async () => {
  const k = stopKit(stopBody(fenced));
  const err = await k.obs
    .until('a marked review comment', () => undefined, DEADLINE.stage, k.show('o/exec', 6), {
      ...k.about('o/exec', 6),
      gonePast: k.closeGone('o/exec', 6),
    })
    .then(
      () => undefined,
      (e: unknown) => String(e),
    );
  equal(err?.split('Writer returned blocked').length, 2, err);
  match(
    err ?? '',
    /; observed: o\/exec#6 open \[scope, shaped, pending\] runs: none; last Nibfin comment: Code: STAGE_BLOCKED, Run: https:\/\/github\.com\/o\/exec\/actions\/runs\/46027033527$/,
  );
});
