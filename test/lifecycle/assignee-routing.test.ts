// assignee-routing (Issue #468): whether M2's deliver job started under pause, or after a
// removal of pause that was not the scenario's own (R4.12, R4.26).
import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { Checks } from '../../scenarios/lifecycle/analysis.ts';
import type { Job } from '../../scenarios/lifecycle/analysis.ts';
import { DEADLINE, Kit } from '../../scenarios/lifecycle/kit.ts';
import {
  deliverRanChecks,
  dispatchedBefore,
  pausedDeliverProblem,
  shapeLive,
  shapeMissedNote,
} from '../../scenarios/lifecycle/phase2-fixtures.ts';
import type { PauseEvent } from '../../scenarios/lifecycle/phase2-fixtures.ts';
import { clock, context, routes } from './fake.ts';

const at = (iso: string) => Date.parse(iso);
const added: PauseEvent = { event: 'labeled', actor: 'nibfin-owner', at: at('2026-11-27T10:00:00Z') };
const ownRemoval = { wasOn: true, before: at('2026-11-27T10:10:00Z'), after: at('2026-11-27T10:10:01Z') };
const ownEvent: PauseEvent = { event: 'unlabeled', actor: 'nibfin-owner', at: at('2026-11-27T10:10:00Z') };

test('a deliver job that started after the scenario removed pause passes on to the routing checks', () => {
  equal(pausedDeliverProblem(at('2026-11-27T10:12:00Z'), [ownEvent, added], ownRemoval), undefined);
});

test('a deliver job that started while pause was on fails R4.12/R4.26 naming the start, the events and the tolerance', () => {
  const p = pausedDeliverProblem(at('2026-11-27T10:05:00Z'), [added, ownEvent], ownRemoval);
  match(p ?? '', /started at 2026-11-27T10:05:00\.000Z while pause was on/);
  match(
    p ?? '',
    /labeled by nibfin-owner at 2026-11-27T10:00:00\.000Z; unlabeled by nibfin-owner at 2026-11-27T10:10:00\.000Z/,
  );
  match(p ?? '', /5 s tolerance/);
});

test('a deliver job that started after another actor removed pause fails naming that actor and time', () => {
  const other: PauseEvent = { event: 'unlabeled', actor: 'someone-else', at: at('2026-11-27T10:03:00Z') };
  const p = pausedDeliverProblem(at('2026-11-27T10:04:00Z'), [added, other], {
    wasOn: false,
    before: at('2026-11-27T10:10:00Z'),
    after: at('2026-11-27T10:10:01Z'),
  });
  match(p ?? '', /removed by someone-else at 2026-11-27T10:03:00\.000Z, not by the scenario/);
  match(p ?? '', /saw pause already off just before its own removal/);
});

test('a deliver job that started within the tolerance after the own removal passes', () => {
  equal(pausedDeliverProblem(at('2026-11-27T10:10:03Z'), [added, ownEvent], ownRemoval), undefined);
});

test("a deliver job that started within the tolerance before the own removal counts in the product's favor", () => {
  equal(pausedDeliverProblem(at('2026-11-27T10:09:57Z'), [added, ownEvent], ownRemoval), undefined);
});

test("a removal in the own window does not count as the scenario's when pause was already off before it", () => {
  const p = pausedDeliverProblem(at('2026-11-27T10:12:00Z'), [added, ownEvent], { ...ownRemoval, wasOn: false });
  match(p ?? '', /removed by nibfin-owner at 2026-11-27T10:10:00\.000Z, not by the scenario/);
});

// assignee-routing (Issue #596): M2 is reassigned as soon as its shape run or job is seen
// queued or running through direct reads (R4.24), and a Shape the scenario missed names the
// rules it could not exercise instead of ending the scenario (R4.20, R4.24, R4.26, R1.14).
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
/** Routes for one shape run 5 whose listed and direct status follow `status`, and whose jobs follow `jobs`. */
const shapeRoutes = (
  c: ReturnType<typeof clock>,
  o: { status: (t: number) => string | undefined; jobs: () => Job[]; deliver?: (t: number) => boolean; issue?: object },
) =>
  routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => {
      const t = c.now() - T0;
      const st = o.status(t);
      return {
        workflow_runs: [
          ...(st ? [run(5, 'shape', st, iso(30_000))] : []),
          ...(o.deliver?.(t) ? [run(7, 'deliver', 'in_progress', iso(55_000))] : []),
        ],
      };
    },
    'GET /repos/o/exec/actions/runs/5': () => ({
      data: run(5, 'shape', o.status(c.now() - T0) ?? 'queued', iso(30_000)),
    }),
    'GET /repos/o/exec/actions/runs/5/jobs': () => ({ jobs: o.jobs() }),
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [o.issue ?? issue],
    // `pending` added past REPAIR_GRACE before the wait, with no repair record, ends it at once.
    'GET /repos/o/exec/issues/6/comments': [],
    'GET /repos/o/exec/issues/6/events': [
      { event: 'labeled', created_at: iso(-3_600_000), label: { name: 'pending' } },
    ],
  });
const direct = (calls: string[]) =>
  calls.filter((x) => x.startsWith('GET /repos/o/exec/actions/runs/5/jobs?filter=latest'));

test('a shape run seen only queued, before its job exists, triggers the reassignment', async () => {
  const c = clock(T0);
  const f = shapeRoutes(c, { status: () => 'queued', jobs: () => [] });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const seen = await shapeLive(k, 6, { deadlineMs: DEADLINE.stage });
  equal(seen.kind, 'live');
  if (seen.kind !== 'live') return;
  deepEqual([seen.run.id, seen.run.status, seen.job], [5, 'queued', undefined]);
  equal(direct(f.calls).length, 1, 'read directly');
});

test('a shape run with a queued self-hosted job triggers the reassignment with that job', async () => {
  const c = clock(T0);
  const f = shapeRoutes(c, { status: () => 'in_progress', jobs: () => [timedJob(c.now, 70_000, 100_000)] });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const seen = await shapeLive(k, 6, { deadlineMs: DEADLINE.stage });
  equal(seen.kind, 'live');
  if (seen.kind === 'live') deepEqual([seen.job?.id, seen.job?.status], [11, 'queued']);
});

test('a shape job in progress for less than one snapshot interval triggers the reassignment through the direct reads', async () => {
  const c = clock(T0);
  // The snapshot at 0 s has no shape run; the one at 60 s lists it while its 20 s job runs.
  const f = shapeRoutes(c, {
    status: (t) => (t < 50_000 ? undefined : t < 80_000 ? 'in_progress' : 'completed'),
    jobs: () => [timedJob(c.now, 55_000, 75_000)],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const seen = await shapeLive(k, 6, { deadlineMs: DEADLINE.stage });
  equal(seen.kind, 'live');
  if (seen.kind === 'live')
    deepEqual([seen.job?.id, seen.job?.status, seen.at - T0 < 75_000], [11, 'in_progress', true]);
  equal(direct(f.calls).length >= 1, true, 'read directly');
  equal(
    f.calls.some((x) => x.startsWith('GET /repos/o/exec/actions/runs/5/jobs?filter=all')),
    false,
    "not through the observer's cached job reads",
  );
});

test('a shape job that completed between two looks, with no deliver run yet, is missed without throwing and named with its times', async () => {
  const c = clock(T0);
  const f = shapeRoutes(c, {
    status: (t) => (t < 30_000 ? undefined : t < 52_000 ? 'in_progress' : 'completed'),
    jobs: () => [timedJob(c.now, 40_000, 50_000)],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const seen = await shapeLive(k, 6, { deadlineMs: DEADLINE.stage, show: k.show('o/exec', 6) });
  equal(seen.kind, 'missed');
  if (seen.kind !== 'missed') return;
  equal(seen.deliver, undefined);
  const note = shapeMissedNote(seen);
  match(
    note,
    new RegExp(
      `^M2's shape job 11 \\(run 5\\) ran from ${iso(40_000)} to ${iso(50_000)} before the scenario saw its run or job queued or in progress: `,
    ),
  );
  match(
    note,
    new RegExp(
      `the wait first read it at ${iso(60_000)}, already completed, and its previous look was at ${iso(0)} \\(no unfinished shape run on its snapshot\\)`,
    ),
  );
  const ch = new Checks();
  ch.notExercised('R4.24', note);
  match(ch.outcome('passed').reason, /^R4\.24: not exercised: M2's shape job 11/);
});

test('a shape job missed after Deliver ran leaves R4.20, R4.24 and R4.26 not exercised and judges R4.18', async () => {
  const c = clock(T0);
  const f = shapeRoutes(c, {
    status: (t) => (t < 30_000 ? undefined : t < 52_000 ? 'in_progress' : 'completed'),
    jobs: () => [timedJob(c.now, 40_000, 50_000)],
    deliver: (t) => t >= 55_000,
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const seen = await shapeLive(k, 6, { deadlineMs: DEADLINE.stage });
  equal(seen.kind, 'missed');
  if (seen.kind !== 'missed') return;
  equal(seen.deliver?.id, 7);
  const deliverRun = { ...run(7, 'deliver', 'in_progress', iso(55_000)), repo: 'o/exec' };
  const deliver = { ...timedJob(() => T0 + 90_000, 58_000, 200_000, { id: 21, run: 7 }), run: deliverRun };
  for (const [labels, r418] of [
    [['self-hosted', 'nibfin-1'], false],
    [['self-hosted', 'nibfin-2'], true],
  ] as const) {
    const ch = new Checks();
    deliverRanChecks(ch, seen, { ...deliver, labels: [...labels] }, 'nibfin-1');
    const reason = ch.outcome('passed').reason;
    for (const rule of ['R4.20', 'R4.24', 'R4.26']) {
      match(
        reason,
        new RegExp(
          `${rule.replace('.', '\\.')}: not exercised: M2's Deliver had already run before the scenario could reassign it: shape job 11 \\(run 5\\) ran from ${iso(40_000)} to ${iso(50_000)}; deliver job 21 \\(run 7\\) started ${iso(58_000)}`,
        ),
      );
    }
    equal(/R4\.18: /.test(reason), r418);
  }
});

test('a deliver run created before the reassignment leaves R4.20 not exercised, naming its ids and times', () => {
  const deliverRun = { ...run(7, 'deliver', 'in_progress', iso(55_000)), repo: 'o/exec' };
  const deliver = { ...timedJob(() => T0 + 90_000, 58_000, 200_000, { id: 21, run: 7 }), run: deliverRun };
  match(
    dispatchedBefore(deliver, T0 + 56_000) ?? '',
    new RegExp(
      `deliver job 21 \\(run 7, created ${iso(55_000)}, job started ${iso(58_000)}\\) was dispatched before the reassignment at ${iso(56_000)}`,
    ),
  );
  equal(dispatchedBefore(deliver, T0 + 55_000), undefined);
});

test('M2 closed or with pending still ends the shape wait', async () => {
  for (const i of [
    { ...issue, state: 'closed', state_reason: 'not_planned', closed_at: iso(-3_600_000) },
    { ...issue, labels: [{ name: 'scope' }, { name: 'pending' }] },
  ]) {
    const c = clock(T0);
    const f = shapeRoutes(c, { status: () => undefined, jobs: () => [], issue: i });
    const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
    await rejects(
      shapeLive(k, 6, { deadlineMs: DEADLINE.stage }),
      /^Error: gave up waiting for M2's shape run or job to be queued or running: #6 (is closed|has pending)/,
    );
  }
});
