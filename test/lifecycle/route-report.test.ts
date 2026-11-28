import { deepEqual, doesNotMatch, equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub } from '../../src/host/github.ts';
import { Kit } from '../../scenarios/lifecycle/kit.ts';
import { BLOCKER_REPORT } from '../../scenarios/lifecycle/marks.ts';
import {
  EVIDENCE_TOTAL,
  reportFailure,
  routeEvidence,
  routeReport,
} from '../../scenarios/lifecycle/phase2-journeys.ts';
import { clock, context, routes } from './fake.ts';

const empty = {
  'GET /repos/o/exec/issues': [],
  'GET /repos/o/exec/pulls': [],
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /rate_limit': { resources: { core: { remaining: 4999 } } },
};
const ran = {
  id: 11,
  name: 'job / route',
  status: 'completed',
  conclusion: 'success',
  labels: ['ubuntu-24.04'],
  runner_name: 'GitHub Actions 1',
  runner_group_name: 'GitHub Actions',
  started_at: '2026-11-26T10:02:00Z',
  completed_at: '2026-11-26T10:03:00Z',
};
const skipped = { ...ran, id: 12, conclusion: 'skipped', runner_name: null, runner_group_name: null };
const comment = (body: string, at = '2026-11-26T10:04:00Z') => ({
  id: 1,
  body,
  created_at: at,
  updated_at: at,
  user: null,
  html_url: 'https://c/1',
});

/** A Kit over one route run of Issue 5 with these jobs; `logs.example` answers each ran job's log with `log` (404 when undefined), or job 13's with `late`. */
async function setup(jobs: object[], log: string | undefined, comments: object[], late?: string) {
  const f = routes({
    ...empty,
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [
        { id: 1, display_title: 'Nibfin · o/exec#5 · route', status: 'completed', created_at: '2026-11-26T10:01:00Z' },
      ],
    },
    'GET /repos/o/exec/actions/runs/1/jobs': { jobs },
    'GET /repos/o/exec/actions/jobs/11/logs': { status: 302, headers: { location: 'https://logs.example/11' } },
    'GET /repos/o/exec/actions/jobs/12/logs': { status: 302, headers: { location: 'https://logs.example/12' } },
    'GET /repos/o/exec/actions/jobs/13/logs': { status: 302, headers: { location: 'https://logs.example/13' } },
    'GET /repos/o/exec/issues/5/comments': comments,
  });
  const withLogs: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://logs.example/13')
      return new Response(late ?? 'gone', { status: late === undefined ? 404 : 200 });
    return url.startsWith('https://logs.example/')
      ? new Response(log ?? 'gone', { status: log === undefined ? 404 : 200 })
      : f.fetchFn(input, init);
  };
  const c = clock();
  const k = new Kit(context(createGitHub(() => 'tok', withLogs)), { now: c.now, sleep: c.sleep });
  return { k, s: await k.obs.next(), calls: f.calls };
}

test('route report: an unreadable route-job log gives no evidence; a marked comment by the cutoff still reports', async () => {
  const { k, s } = await setup([ran], undefined, [comment('<!-- nibfin:route --> Waiting: blocked by #4')]);
  const r = await routeReport(k, s, 5, BLOCKER_REPORT, Date.parse('2026-11-26T10:05:00Z'));
  equal(r.reported, true);
  equal(r.unreadable.length, 1);
});

test('route report: an unreadable log and no matching comment is not reported, and the job is named with its error', async () => {
  const { k, s } = await setup([ran], undefined, [
    comment('<!-- nibfin:route --> Waiting: blocked by #4', '2026-11-26T10:30:00Z'),
    comment('blocked by #4, unmarked'),
  ]);
  const r = await routeReport(k, s, 5, BLOCKER_REPORT, Date.parse('2026-11-26T10:05:00Z'));
  equal(r.reported, false);
  equal(r.unreadable.length, 1);
  match(
    r.unreadable[0] as string,
    /^route job 11 \(run 1\): GitHub GET \/repos\/o\/exec\/actions\/jobs\/11\/logs returned 404: the redirected download failed$/,
  );
  match(
    reportFailure("B's route did not report its open blocker", r),
    /^B's route did not report its open blocker; route job logs unreadable: route job 11 \(run 1\): .*404/,
  );
  equal(
    reportFailure("U's route did not report the missing Assignee", { reported: false, unreadable: [] }),
    "U's route did not report the missing Assignee",
  );
});

test('route report: a skipped route job is not read', async () => {
  const { k, s, calls } = await setup([skipped], 'blocked by #4', []);
  deepEqual(await routeReport(k, s, 5, BLOCKER_REPORT), { reported: false, unreadable: [] });
  equal(
    calls.some((x) => x.includes('/actions/jobs/12/logs')),
    false,
  );
});

test('route report: a readable route-job log that matches reports', async () => {
  const { k, s, calls } = await setup([skipped, ran], '2026-11-26T10:02:30Z Issue #5 is blocked by #4\n', []);
  deepEqual(await routeReport(k, s, 5, BLOCKER_REPORT, Date.parse('2026-11-26T10:05:00Z')), {
    reported: true,
    unreadable: [],
  });
  equal(
    calls.some((x) => x.includes('/actions/jobs/11/logs')),
    true,
  );
  equal(
    calls.some((x) => x.includes('/actions/jobs/12/logs')),
    false,
  );
});

const cutoff = Date.parse('2026-11-26T10:05:00Z');
const why = "B's route did not report its open blocker";
const late = { ...ran, id: 13, started_at: '2026-11-26T10:06:00Z', completed_at: '2026-11-26T10:07:00Z' };

test('route report: a read log with no match names the job and quotes a bounded excerpt', async () => {
  const log = [
    '2026-11-26T10:02:01Z ##[group]Run actions/checkout',
    '2026-11-26T10:02:02Z setting up',
    '',
    '2026-11-26T10:02:30Z Issue #5 is waiting on #4',
    '2026-11-26T10:02:40Z #50 unrelated',
    '2026-11-26T10:02:50Z done',
  ].join('\n');
  const { k, s } = await setup([ran], log, []);
  const r = await routeReport(k, s, 5, BLOCKER_REPORT, cutoff);
  equal(r.reported, false);
  const m = reportFailure(why, r, await routeEvidence(k, s, 5, cutoff));
  match(
    m,
    /^B's route did not report its open blocker; route jobs read: job 11 \(run 1, success, completed 2026-11-26T10:03:00Z\) lines naming #5: `Issue #5 is waiting on #4`; route jobs skipped: none; /,
  );
  doesNotMatch(m, /unrelated|##\[/);
  equal(reportFailure(why, r), why);
});

test('route report: with no line naming the Issue, the last lines are quoted, each cut, within the total cap', async () => {
  const long = 'x'.repeat(400);
  const log = Array.from(
    { length: 12 },
    (_, i) => `2026-11-26T10:02:${String(i).padStart(2, '0')}Z line ${i} ${long}`,
  ).join('\n');
  const { k, s } = await setup([ran], log, []);
  const e = await routeEvidence(k, s, 5, cutoff);
  match(e, /job 11 \(run 1, success, completed 2026-11-26T10:03:00Z\) last lines: `line 7 x+…`/);
  doesNotMatch(e, /line 6 /);
  for (const q of e.match(/`[^`]*`/g) ?? []) ok(q.length <= 162, q);
  equal((e.match(/`line \d+/g) ?? []).length, 5);
  ok(e.length <= EVIDENCE_TOTAL);
});

test('route report: the total evidence is cut to the cap', async () => {
  const comments = Array.from({ length: 5 }, (_, i) => ({
    ...comment(`<!-- nibfin:route${i} --> ${'y'.repeat(300)}`),
    id: i + 1,
  }));
  const jobs = Array.from({ length: 6 }, () => ran);
  const { k, s } = await setup(
    jobs,
    Array.from({ length: 5 }, () => `Issue #5 ${'z'.repeat(300)}`).join('\n'),
    comments,
  );
  const e = await routeEvidence(k, s, 5, cutoff);
  equal(e.length, EVIDENCE_TOTAL);
  ok(e.endsWith('…'));
});

test('route report: a route job completed after the cutoff is named as skipped and not read', async () => {
  const { k, s, calls } = await setup([skipped, late], undefined, [], 'blocked by #4');
  const r = await routeReport(k, s, 5, BLOCKER_REPORT, cutoff);
  deepEqual(r, { reported: false, unreadable: [] });
  const e = await routeEvidence(k, s, 5, cutoff);
  match(
    e,
    /route jobs read: none; route jobs skipped: job 12 \(run 1\): not run on a runner; job 13 \(run 1\): completed after the cutoff 2026-11-26T10:05:00\.000Z; /,
  );
  equal(
    calls.some((x) => x.includes('/actions/jobs/13/logs')),
    false,
  );
});

test('route report: no marked comment by the cutoff is stated, ignoring later marked and earlier unmarked ones', async () => {
  const { k, s } = await setup([], undefined, [
    comment('<!-- nibfin:route --> Waiting: blocked by #4', '2026-11-26T10:30:00Z'),
    comment('blocked by #4, unmarked'),
  ]);
  const e = await routeEvidence(k, s, 5, cutoff);
  match(e, /; no marked comment by 2026-11-26T10:05:00\.000Z$/);
  match(await routeEvidence(k, s, 5), /; marked comments: read 1 comment: #1 marker route "Waiting: blocked by #4"$/);
});

test('route report: an unreadable log is shown as unreadable in the evidence, and marked comments are quoted', async () => {
  const { k, s } = await setup([ran], undefined, [comment('<!-- nibfin:route --> Routed: no stage yet')]);
  const r = await routeReport(k, s, 5, BLOCKER_REPORT, cutoff);
  const m = reportFailure(why, r, await routeEvidence(k, s, 5, cutoff));
  match(
    m,
    /route job logs unreadable: route job 11 \(run 1\): .*404.*; route jobs read: job 11 \(run 1, success, completed 2026-11-26T10:03:00Z\) log unreadable; route jobs skipped: none; marked comments by 2026-11-26T10:05:00\.000Z: read 1 comment: #1 marker route "Routed: no stage yet"$/,
  );
});
