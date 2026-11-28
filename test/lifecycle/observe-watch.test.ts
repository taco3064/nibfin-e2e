// A wait that watches one Issue sees its stage runs and their jobs read again every watch
// interval, between the full snapshots (Issue #717, Proposal R4.12, R4.24, R4.35): a short
// stage is seen running, other waits keep the full interval, and completed reads stay cached.
import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../../scenarios/lifecycle/analysis.ts';
import { stageJobRunning } from '../../scenarios/lifecycle/journeys.ts';
import { DEADLINE, Kit } from '../../scenarios/lifecycle/kit.ts';
import { Observer } from '../../scenarios/lifecycle/observe.ts';
import type { Snapshot } from '../../scenarios/lifecycle/observe.ts';
import { clock, context, routes } from './fake.ts';

const NO_ISSUE = { noIssue: 'the test exercises the observer itself' } as const;
const T0 = Date.parse('2026-11-26T10:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const base = {
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /repos/o/exec/pulls': [],
  'GET /rate_limit': {},
};
const run = (id: number, issue: number, stage: string, status: string, created: string) => ({
  id,
  display_title: `Nibfin · o/exec#${issue} · ${stage}`,
  status,
  conclusion: status === 'completed' ? 'success' : null,
  created_at: created,
  name: 'Nibfin',
  event: 'workflow_dispatch',
  head_sha: 'h',
});
const job = (id: number, runId: number, status: string): Job => ({
  id,
  run_id: runId,
  name: 'stage',
  status,
  conclusion: status === 'completed' ? 'success' : null,
  labels: ['self-hosted', 'nibfin-1'],
  runner_name: status === 'queued' ? null : 'claude-1',
  started_at: status === 'queued' ? null : iso(0),
  completed_at: status === 'completed' ? iso(1_000) : null,
});
const count = (calls: string[], prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;

/**
 * Virtual time for concurrent waits: `sleep` resolves when the driver reaches its time, and
 * the driver moves to the earliest pending sleep once every promise has settled as far as
 * it can, so two waits sleeping at once wake in time order.
 */
function timers(start = T0) {
  let t = start;
  const queue: { at: number; wake: () => void }[] = [];
  const now = () => t;
  const sleep = (ms: number) => new Promise<void>((wake) => void queue.push({ at: t + Math.max(0, ms), wake }));
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  async function drive<T>(p: Promise<T>): Promise<T> {
    let done = false;
    const out = p.finally(() => (done = true));
    out.catch(() => {});
    for (let i = 0; i < 10_000 && !done; i++) {
      await settle();
      if (done) break;
      queue.sort((a, b) => a.at - b.at);
      const next = queue.shift();
      if (!next) continue;
      t = Math.max(t, next.at);
      next.wake();
    }
    return out;
  }
  return { now, sleep, drive };
}

test('a shape job shorter than the full interval, created after one full snapshot, is seen running by a watching wait', async () => {
  const c = clock(T0);
  const t = () => c.now() - T0;
  // Created at 35 s, after the full snapshot at 30 s; its job runs from 42 s to 55 s; all done before the full snapshot at 60 s.
  const status = () => (t() < 35_000 ? undefined : t() < 56_000 ? 'in_progress' : 'completed');
  const jobStatus = () => (t() < 42_000 ? 'queued' : t() < 55_000 ? 'in_progress' : 'completed');
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => {
      const st = status();
      return { workflow_runs: st ? [run(5, 6, 'shape', st, iso(35_000))] : [] };
    },
    'GET /repos/o/exec/actions/runs/5/jobs': () => ({ jobs: [job(11, 5, jobStatus())] }),
    'GET /repos/o/exec/issues': [{ number: 6, title: 't', state: 'open', labels: [{ name: 'scope' }] }],
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const j = await stageJobRunning(k, 6, 'shape', { desc: "P's shape job to run", deadlineMs: DEADLINE.stage });
  deepEqual([j.id, j.status, j.run.id], [11, 'in_progress', 5]);
  equal(t(), 50_000, 'seen on the watched read at 50 s');
  equal(count(f.calls, 'GET /repos/o/exec/issues?'), 2, 'Issues were listed by the full snapshots at 0 s and 30 s only');
});

test('a wait that does not watch is called on full snapshots only, while a watching wait reads the runs every watch interval', async () => {
  const v = timers();
  const t = () => v.now() - T0;
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [run(5, 6, 'shape', 'in_progress', iso(0))] },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [job(11, 5, 'in_progress')] },
    'GET /repos/o/exec/issues': [],
  });
  const obs = new Observer(f.github, ['o/exec', 'o/peer'], { since: T0, now: v.now, sleep: v.sleep });
  const plain: { gen: number; at: number }[] = [];
  const watched: { gen: number; at: number }[] = [];
  const record = (into: { gen: number; at: number }[], until: number) => (s: Snapshot) => {
    into.push({ gen: s.gen, at: s.at - T0 });
    return t() >= until ? true : undefined;
  };
  await v.drive(
    Promise.all([
      obs.until('plain', record(plain, 90_000), DEADLINE.stage, undefined, NO_ISSUE),
      obs.until('watched', record(watched, 90_000), DEADLINE.stage, undefined, { ...NO_ISSUE, watch: { issueRepo: 'o/exec', issue: 6 } }),
    ]),
  );
  deepEqual(
    plain.map((x) => x.at),
    [0, 30_000, 60_000, 90_000],
    'the plain wait saw the full snapshots only',
  );
  deepEqual(
    plain.map((x) => x.gen),
    [1, 2, 3, 4],
  );
  deepEqual(
    watched.map((x) => x.at),
    [0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000],
    'the watching wait also saw a view every 10 s',
  );
  equal(count(f.calls, 'GET /repos/o/exec/issues?'), 4, 'Issues are listed at the full interval only');
  equal(count(f.calls, 'GET /repos/o/exec/pulls?'), 4, 'pulls are listed at the full interval only');
  equal(count(f.calls, 'GET /repos/o/peer/actions/runs?'), 4, "the peer's runs are listed at the full interval only");
  equal(count(f.calls, 'GET /repos/o/exec/actions/runs?'), 10, "the execution repository's runs are listed on every read");
});

test("a watched Issue's completed runs and jobs stay cached, its unfinished ones are read again after the watch interval", async () => {
  const c = clock(T0);
  let listings = 0;
  const f = routes({
    ...base,
    // Only the first listing returns the runs, so later reads of them are re-reads by id.
    'GET /repos/o/exec/actions/runs': () => ({
      workflow_runs:
        listings++ === 0
          ? [
              run(5, 6, 'shape', 'completed', iso(0)),
              run(8, 6, 'deliver', 'in_progress', iso(0)),
              run(9, 7, 'deliver', 'in_progress', iso(0)),
            ]
          : [],
    }),
    'GET /repos/o/exec/actions/runs/8': { data: run(8, 6, 'deliver', 'in_progress', iso(0)) },
    'GET /repos/o/exec/actions/runs/9': { data: run(9, 7, 'deliver', 'in_progress', iso(0)) },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [job(11, 5, 'completed')] },
    'GET /repos/o/exec/actions/runs/8/jobs': { jobs: [job(12, 8, 'in_progress')] },
    'GET /repos/o/exec/actions/runs/9/jobs': { jobs: [job(13, 9, 'in_progress')] },
    'GET /repos/o/exec/issues': [],
  });
  const obs = new Observer(f.github, ['o/exec', 'o/peer'], { since: T0, now: c.now, sleep: c.sleep });
  let calls = 0;
  await obs.until(
    'four reads',
    async () => {
      // Twice per read: the second is served from the cache of this read.
      for (let i = 0; i < 2; i++) for (const id of [5, 8, 9]) await obs.jobs('o/exec', id);
      return ++calls >= 4 ? true : undefined;
    },
    DEADLINE.stage,
    undefined,
    { ...NO_ISSUE, watch: { issueRepo: 'o/exec', issue: 6 } },
  );
  equal(c.now() - T0, 30_000, 'reads at 0, 10, 20 and 30 s');
  equal(count(f.calls, 'GET /repos/o/exec/actions/runs/5/jobs'), 1, "the watched Issue's completed jobs are read once");
  equal(count(f.calls, 'GET /repos/o/exec/actions/runs/8/jobs'), 4, "the watched Issue's unfinished jobs are read on each read");
  equal(count(f.calls, 'GET /repos/o/exec/actions/runs/9/jobs'), 2, "another Issue's jobs are read once per full snapshot");
  equal(f.calls.filter((x) => x === 'GET /repos/o/exec/actions/runs/5').length, 0, 'a completed run is never read again');
  equal(f.calls.filter((x) => x === 'GET /repos/o/exec/actions/runs/8').length, 3, "the watched Issue's unfinished run is read again on each read");
  equal(f.calls.filter((x) => x === 'GET /repos/o/exec/actions/runs/9').length, 1, "another Issue's run is read again on full snapshots only");
});

test('each full read logs the GitHub API usage: used, remaining, limit and the reset time', async () => {
  const c = clock(T0);
  const logs: string[] = [];
  const reset = Math.floor((T0 + 1_800_000) / 1000);
  const f = routes({
    ...base,
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
