// The shared observer of the issue-fixture kit: one snapshot per interval for every waiter,
// cached detail reads, merged run listings, failed reads and the API-usage log.
import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { Observer } from '../../scenarios/lib/observer.ts';
import { clock, routes } from './fake.ts';

/** The options of a test wait that exercises the observer itself, not an Issue. */
const NO_ISSUE = { noIssue: 'the test exercises the observer itself' };
const T0 = Date.parse('2026-11-26T10:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const empty = {
  'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
  'GET /repos/o/exec/issues': [],
  'GET /repos/o/exec/pulls': [],
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /rate_limit': { resources: { core: { remaining: 4999 } } },
};

test('waiters share one snapshot, refreshed at most once per interval', async () => {
  const f = routes(empty);
  const c = clock();
  const obs = new Observer(f.github, ['o/exec', 'o/peer'], {
    since: c.now(),
    now: c.now,
    sleep: c.sleep,
    intervalMs: 60_000,
  });
  let polls = 0;
  const waiter = (after: number) => obs.until('x', () => (++polls >= after ? true : undefined), 600_000, undefined, NO_ISSUE);
  await Promise.all([waiter(3), waiter(4), waiter(5)]);
  const reads = f.calls.filter((x) => x.startsWith('GET /repos/o/exec/actions/runs'));
  equal(reads.length <= 3, true, `${reads.length} snapshots for three waiters`);
  match(reads[0] ?? '', /created=%3E%3D2026-11-26T10%3A00%3A00Z/);
});

test('until fails at its deadline naming what it waited for and the observed state', async () => {
  const c = clock();
  const obs = new Observer(routes(empty).github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep });
  await rejects(
    obs.until(
      'A to close',
      () => undefined,
      5 * 60_000,
      () => 'o/exec#1 open [scope]',
      NO_ISSUE,
    ),
    /timed out after 5 min waiting for A to close; observed: o\/exec#1 open \[scope\]/,
  );
});

test('jobs are read again each snapshot until they complete, then cached', async () => {
  let status = 'in_progress';
  const f = routes({ ...empty, 'GET /repos/o/exec/actions/runs/7/jobs': () => ({ jobs: [{ id: 1, status }] }) });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep });
  const count = () => f.calls.filter((x) => x.startsWith('GET /repos/o/exec/actions/runs/7/jobs')).length;
  await obs.next();
  await obs.jobs('o/exec', 7);
  await obs.jobs('o/exec', 7);
  equal(count(), 1);
  status = 'completed';
  await obs.fresh();
  await obs.jobs('o/exec', 7);
  await obs.fresh();
  await obs.jobs('o/exec', 7);
  equal(count(), 2);
});

test('runs once seen are kept; later listings cover only recent runs and unfinished older runs are re-read', async () => {
  const run = (id: number, status: string, created: string) => ({
    id,
    display_title: `Nibfin · o/exec#${id} · shape`,
    status,
    created_at: created,
  });
  let listing = [run(1, 'in_progress', '2026-11-26T10:00:30Z'), run(2, 'completed', '2026-11-26T10:00:40Z')];
  let one = run(1, 'in_progress', '2026-11-26T10:00:30Z');
  const f = routes({
    'GET /repos/o/exec/actions/runs': () => ({ data: { workflow_runs: listing } }),
    'GET /repos/o/exec/actions/runs/1': () => ({ data: one }),
    'GET /repos/o/exec/issues': [],
    'GET /repos/o/exec/pulls': [],
    'GET /rate_limit': {},
  });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, intervalMs: 60_000 });
  await obs.next();
  c.advance(30 * 60_000);
  listing = [run(3, 'queued', '2026-11-26T10:30:00Z')];
  one = run(1, 'completed', '2026-11-26T10:00:30Z');
  const s = await obs.fresh();
  deepEqual(s.runs.map((r) => [r.id, r.status]).sort(), [
    [1, 'completed'],
    [2, 'completed'],
    [3, 'queued'],
  ]);
  c.advance(30 * 60_000);
  await obs.fresh();
  const lists = f.calls.filter((x) => x.startsWith('GET /repos/o/exec/actions/runs?'));
  match(lists[0] ?? '', /created=%3E%3D2026-11-26T10%3A00%3A00Z/);
  match(lists[1] ?? '', /created=%3E%3D2026-11-26T10%3A00%3A00Z/, 'never before the start');
  match(lists[2] ?? '', /created=%3E%3D2026-11-26T10%3A20%3A00Z/, 'ten minutes before the previous listing');
  equal(
    f.calls.filter((x) => x === 'GET /repos/o/exec/actions/runs/1').length,
    1,
    'only the unfinished run missing from the listing is re-read',
  );
});

test('a failed read during a wait is logged and the wait goes on; the deadline names the last error', async () => {
  let fail = 2;
  const logs: string[] = [];
  const f = routes({
    ...empty,
    'GET /repos/o/exec/issues': () => (fail-- > 0 ? { status: 502, data: { message: 'Bad Gateway' } } : { data: [] }),
  });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], {
    since: c.now(),
    now: c.now,
    sleep: c.sleep,
    log: (m) => logs.push(m),
  });
  const started = c.now();
  equal(await obs.until('anything', () => true, 10 * 60_000, undefined, NO_ISSUE), true);
  equal(c.now() - started >= 2 * 30_000, true, 'each retry of the read waits one interval (30 s by default)');
  equal(logs.filter((l) => /a read while waiting for anything failed: .*502/.test(l)).length, 2);
  const broken = routes({ ...empty, 'GET /repos/o/exec/issues': { status: 502, data: { message: 'Bad Gateway' } } });
  const obs2 = new Observer(broken.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep });
  await rejects(
    obs2.until('B', () => true, 3 * 60_000, undefined, NO_ISSUE),
    /timed out after 3 min waiting for B; last read error: GitHub GET \/repos\/o\/exec\/issues.* returned 502: Bad Gateway/,
  );
});

test('each full read logs the GitHub API usage: used, remaining, limit and the reset time', async () => {
  const c = clock(T0);
  const logs: string[] = [];
  const reset = Math.floor((T0 + 1_800_000) / 1000);
  const f = routes({
    ...empty,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [],
    'GET /rate_limit': { resources: { core: { limit: 5000, used: 120, remaining: 4880, reset } } },
  });
  const obs = new Observer(f.github, ['o/exec', 'o/peer'], { since: T0, now: c.now, sleep: c.sleep, log: (m) => logs.push(m) });
  await obs.fresh();
  await obs.fresh();
  const lines = logs.filter((l) => l.startsWith('observer: snapshot'));
  equal(lines.length, 2);
  match(
    lines[1] ?? '',
    new RegExp(`^observer: snapshot 2, 0 runs; GitHub API: 120 used, 4880 remaining of 5000 this hour, resets at ${iso(1_800_000)}$`),
  );
});
