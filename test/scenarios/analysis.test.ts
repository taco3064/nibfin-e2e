// The pure readings the issue-fixture kit shares: stage and wake titles, stage runs, agent
// jobs, comment markers and per-rule checks.
import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import {
  Checks,
  describeComments,
  markerOf,
  parseStageTitle,
  parseWakeTitle,
  selfHosted,
  stageRuns,
} from '../../scenarios/lib/analysis.ts';
import type { Job, Run } from '../../scenarios/lib/analysis.ts';

const run = (id: number, title: string, extra: Partial<Run> = {}): Run => ({
  id,
  repo: 'o/exec',
  name: 'Nibfin · Shared runner',
  display_title: title,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  created_at: `2026-11-26T10:0${id}:00Z`,
  head_sha: 'm',
  ...extra,
});

const job = (id: number, extra: Partial<Job> = {}): Job => ({
  id,
  run_id: 1,
  name: 'stage',
  status: 'completed',
  conclusion: 'success',
  labels: ['self-hosted', 'nibfin-42'],
  runner_name: 'claude-1',
  started_at: '2026-11-26T10:00:00Z',
  completed_at: '2026-11-26T10:10:00Z',
  ...extra,
});

test('stage and wake titles are parsed; stage runs are per Issue and in creation order', () => {
  deepEqual(parseStageTitle('Nibfin · o/peer#12 · deliver'), { repo: 'o/peer', issue: 12, stage: 'deliver' });
  equal(parseStageTitle('Nibfin · o/peer#12 · wake'), undefined);
  deepEqual(parseWakeTitle('Nibfin · o/peer#12 · wake'), { repo: 'o/peer', issue: 12 });
  equal(parseWakeTitle('Nibfin · o/peer#12 · deliver'), undefined);
  const runs = [
    run(3, 'Nibfin · o/exec#5 · deliver'),
    run(1, 'Nibfin · o/exec#5 · route'),
    run(2, 'Nibfin · o/exec#50 · shape'),
    run(4, 'Nibfin · o/exec#5 · shape', { repo: 'o/peer' }),
  ];
  deepEqual(
    stageRuns(runs, 'o/exec', 'o/exec', 5).map((r) => [r.id, r.stage]),
    [
      [1, 'route'],
      [3, 'deliver'],
    ],
  );
  deepEqual(
    stageRuns(runs, 'o/exec', 'o/exec', 5, ['shape', 'deliver']).map((r) => r.id),
    [3],
  );
});

test('an agent job runs on a self-hosted Runner or one with the Owner routing label', () => {
  equal(selfHosted(job(1)), true);
  equal(selfHosted(job(2, { labels: ['self-hosted'] })), true);
  equal(selfHosted(job(3, { labels: ['ubuntu-24.04'] })), false);
});

test('comment markers, and a description of the comments a wait read', () => {
  equal(markerOf('text <!-- nibfin:pending --> more'), 'pending');
  equal(markerOf('plain'), undefined);
  const c = (body: string) => ({ id: 1, body, created_at: 'c', updated_at: 'u', user: null, html_url: 'h' });
  equal(describeComments([]), 'read 0 comments');
  equal(
    describeComments([c('<!-- nibfin:pending -->\nNibfin stopped.'), c('plain')]),
    'read 2 comments: #1 marker pending "Nibfin stopped."; #2 no marker "plain"',
  );
  match(describeComments([c('x'.repeat(100))], { stamps: true }), /^read 1 comment: #1 no marker \(created c, updated u, h\) "x{80}…"$/);
});

test('Checks: problems fail with their rule; not exercised is a failure; notes are kept', () => {
  const c = new Checks();
  c.check('R1.1', true, 'unused');
  c.note('first clause only');
  deepEqual(c.outcome('ok'), { status: 'passed', reason: 'ok (first clause only)' });
  c.notExercised('R4.23', 'started early');
  c.none('R3.20', ['a', 'b']);
  deepEqual(c.outcome('ok'), {
    status: 'failed',
    reason: 'R4.23: not exercised: started early; R3.20: a; R3.20: b (first clause only)',
  });
});
