import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { completedKeys, overlapping, r542Decision, snapshotDiff } from '../../scenarios/management/status-views.ts';
import type { Field, Run, Snapshot } from '../../scenarios/management/status-views.ts';

const run = (id: number, status: string, extra: Partial<Run> = {}): Run => ({
  id,
  run_attempt: 1,
  display_title: `Nibfin · #${id}`,
  status,
  conclusion: status === 'completed' ? 'success' : null,
  created_at: '2026-11-27T00:00:00Z',
  html_url: `https://github.com/o/exec/actions/runs/${id}`,
  ...extra,
});

const snap = (): Record<'o/exec' | 'o/peer', Record<Field, string[]>> => ({
  'o/exec': {
    labels: ['pause', 'scope'],
    issues: ['1:pause+scope'],
    pulls: ['2'],
    secrets: ['NIBFIN_GITHUB_TOKEN'],
    variables: ['A=1'],
    runners: ['7:r1:nibfin'],
  },
  'o/peer': { labels: ['scope'], issues: [], pulls: [], secrets: [], variables: [], runners: [] },
});

test('snapshotDiff: identical snapshots give no lines', () => {
  deepEqual(snapshotDiff(snap(), snap()), []);
});

test('snapshotDiff: added and removed entries are reported per repository and field', () => {
  const after = snap();
  after['o/exec'].labels = ['scope', 'shaped'];
  after['o/peer'].pulls = ['5'];
  deepEqual(snapshotDiff(snap(), after), ['o/exec labels: added [shaped]; removed [pause]', 'o/peer pulls: added [5]']);
});

test('snapshotDiff: a repository present on only one side is handled', () => {
  const before: Snapshot = { 'o/exec': snap()['o/exec'] };
  const after: Snapshot = { 'o/peer': snap()['o/peer'] };
  const lines = snapshotDiff(before, after);
  ok(lines.includes('o/exec labels: removed [pause, scope]'), lines.join('\n'));
  ok(lines.includes('o/exec secrets: removed [NIBFIN_GITHUB_TOKEN]'), lines.join('\n'));
  ok(lines.includes('o/peer labels: added [scope]'), lines.join('\n'));
});

test('snapshotDiff: a token-shaped variable value is redacted', () => {
  const after = snap();
  const token = 'ghp_' + 'a'.repeat(36);
  after['o/exec'].variables = ['A=1', `T=${token}`];
  const lines = snapshotDiff(snap(), after);
  deepEqual(lines, ['o/exec variables: added [T=<token>]']);
  ok(!lines.join('').includes(token));
});

test('completedKeys: only completed runs are kept', () => {
  deepEqual(
    [
      ...completedKeys([
        run(1, 'completed'),
        run(2, 'queued'),
        run(3, 'in_progress'),
        run(4, 'completed', { run_attempt: 2 }),
      ]),
    ],
    ['1:1', '4:2'],
  );
});

test('overlapping: runs not in the baseline, re-runs and unfinished runs count', () => {
  const baseline = completedKeys([run(1, 'completed'), run(2, 'completed'), run(3, 'completed')]);
  const now = [
    run(1, 'completed'),
    run(2, 'completed', { run_attempt: 2 }),
    run(3, 'in_progress'),
    run(9, 'completed', { created_at: '2020-01-01T00:00:00Z' }),
  ];
  deepEqual(
    overlapping(baseline, now).map((r) => r.id),
    [2, 3, 9],
  );
});

test('overlapping: a completed run in the baseline does not count, and duplicates appear once', () => {
  const baseline = completedKeys([run(1, 'completed')]);
  deepEqual(overlapping(baseline, [run(1, 'completed'), run(1, 'completed')]), []);
  deepEqual(
    overlapping(baseline, [run(5, 'queued'), run(5, 'queued')]).map((r) => r.id),
    [5],
  );
});

test('overlapping: a run in progress at the baseline read and completed at the second read counts', () => {
  const baseline = completedKeys([run(1, 'completed'), run(2, 'in_progress')]);
  deepEqual(
    overlapping(baseline, [run(1, 'completed'), run(2, 'completed')]).map((r) => r.id),
    [2],
  );
});

test('r542Decision: no change passes, with or without an overlap', () => {
  deepEqual(r542Decision({ diff: [], overlapUrls: [], attempt: 1, maxAttempts: 3 }), { kind: 'pass' });
  deepEqual(r542Decision({ diff: [], overlapUrls: ['u'], attempt: 3, maxAttempts: 3 }), { kind: 'pass' });
});

test('r542Decision: a change with no overlap fails at once and names the change', () => {
  const d = r542Decision({ diff: ['o/exec labels: added [x]'], overlapUrls: [], attempt: 1, maxAttempts: 3 });
  equal(d.kind, 'fail');
  if (d.kind === 'fail')
    match(
      d.reason,
      /^status changed GitHub state of the sandboxes with no Nibfin run overlapping: o\/exec labels: added \[x\]$/,
    );
});

test('r542Decision: a change with an overlap retries while attempts remain', () => {
  deepEqual(r542Decision({ diff: ['d'], overlapUrls: ['u'], attempt: 1, maxAttempts: 3 }), { kind: 'retry' });
  deepEqual(r542Decision({ diff: ['d'], overlapUrls: ['u'], attempt: 2, maxAttempts: 3 }), { kind: 'retry' });
});

test('r542Decision: a change with an overlap on the last attempt fails and names the runs', () => {
  const d = r542Decision({
    diff: ['o/exec issues: removed [1:scope]'],
    overlapUrls: ['https://x/runs/1', 'https://x/runs/2'],
    attempt: 3,
    maxAttempts: 3,
  });
  equal(d.kind, 'fail');
  if (d.kind === 'fail') {
    match(
      d.reason,
      /while Nibfin runs overlapped \(cause not shown to be status\): o\/exec issues: removed \[1:scope\]/,
    );
    match(d.reason, /overlapping runs: https:\/\/x\/runs\/1, https:\/\/x\/runs\/2$/);
  }
});
