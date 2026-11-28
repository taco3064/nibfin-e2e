// Proposal R3.13, R3.40: which shape job is judged for the Validator verdict, the
// verdict pattern, and what the failure messages quote (R1.14).
import { equal, match, doesNotMatch } from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeShapeJobs,
  noPublishingJobMessage,
  noVerdictMessage,
  publishingJob,
  validationQuote,
} from '../../scenarios/lifecycle/analysis.ts';
import type { Job, LogLine } from '../../scenarios/lifecycle/analysis.ts';
import { VALIDATOR_VERDICT } from '../../scenarios/lifecycle/marks.ts';

const ISSUE = 'o/r#7';
const job = (id: number, started: string, completed: string | null): Job => ({
  id,
  run_id: id * 10,
  name: 'job / stage',
  status: completed ? 'completed' : 'in_progress',
  conclusion: completed ? 'success' : null,
  labels: ['self-hosted', 'nibfin-1'],
  runner_name: 'nibfin-1',
  started_at: started,
  completed_at: completed,
});
const first = job(1, '2026-11-27T15:41:28Z', '2026-11-27T15:42:11Z');
const later = job(2, '2026-11-27T16:10:00Z', '2026-11-27T16:10:30Z');
const t = (s: string) => Date.parse(s);

test('VALIDATOR_VERDICT accepts a Validator subject with a result word', () => {
  for (const line of [
    'Validator: approved',
    'Shape validated: pass',
    'validation verdict: accept',
    'validate: approved',
    'Shape approved by the Validator',
    'validating ... OK',
  ]) {
    match(line, VALIDATOR_VERDICT, line);
  }
});

test('VALIDATOR_VERDICT rejects lines without a Validator subject or with it inside another word', () => {
  for (const line of [
    'tests passed',
    'invalidate cache',
    'revalidated',
    'revalidated: pass',
    'invalidated ok',
    'Shape validated',
    'Validator: reviewing Shape',
  ]) {
    doesNotMatch(line, VALIDATOR_VERDICT, line);
  }
});

test('publishingJob picks the job whose window holds the comment creation time, not a later shape job', () => {
  equal(publishingJob([first, later], ISSUE, t('2026-11-27T15:42:05Z')), first);
});

test('publishingJob uses the update time for a rewrite', () => {
  equal(publishingJob([first, later], ISSUE, t('2026-11-27T16:10:20Z')), later);
});

test('publishingJob returns undefined when no window holds the time', () => {
  equal(publishingJob([first, later], ISSUE, t('2026-11-27T15:50:00Z')), undefined);
  equal(publishingJob([], ISSUE, t('2026-11-27T15:42:05Z')), undefined);
  equal(publishingJob([first], ISSUE, NaN), undefined);
});

test('validationQuote quotes at most three validation lines and shortens long ones', () => {
  const long = `Validator ${'x'.repeat(200)}`;
  const lines: LogLine[] = [
    { text: '  Validator: reviewing Shape  ' },
    { text: 'npm ci' },
    { text: long },
    { text: 'validation step 3' },
    { text: 'validation step 4' },
  ];
  const q = validationQuote(lines);
  equal(q.split('; ').length, 3);
  match(q, /^`Validator: reviewing Shape`; /);
  match(q, /`Validator x+…`/);
  equal(q.includes('x'.repeat(151)), false);
  doesNotMatch(q, /npm ci|step 4/);
  equal(validationQuote([{ text: 'npm ci' }]), 'no line mentions validat… or Validator');
});

test('noVerdictMessage names the job, the publication and the validation lines', () => {
  const published = t('2026-11-27T15:42:05Z');
  const lines: LogLine[] = [{ text: 'Validator: reviewing Shape' }, { text: 'git fetch origin main' }];
  const m = noVerdictMessage({ job: 140600476446, n: 142, rewrite: false, published, lines });
  match(m, /shape job 140600476446 of #142/);
  match(m, /published the Shape at 2026-11-27T15:42:05\.000Z/);
  match(m, /nothing observable/);
  match(m, /`Validator: reviewing Shape`/);
  doesNotMatch(m, /git fetch/);
  match(noVerdictMessage({ job: 1, n: 142, rewrite: true, published, lines }), /rewrote the Shape/);
  const none = noVerdictMessage({
    job: 1,
    n: 142,
    rewrite: false,
    published,
    lines: [{ text: 'git fetch origin main' }],
  });
  match(none, /nothing observable/);
  match(none, /no line mentions validat… or Validator/);
});

test('noPublishingJobMessage names the publication time and every shape job with its window', () => {
  const running = job(3, '2026-11-27T17:00:00Z', null);
  const m = noPublishingJobMessage({
    n: 142,
    rewrite: false,
    after: t('2026-11-27T15:00:00Z'),
    published: t('2026-11-27T15:50:00Z'),
    jobs: [first, later, running],
  });
  match(m, /#142/);
  match(m, /published \(2026-11-27T15:50:00\.000Z\)/);
  match(m, /1 2026-11-27T15:41:28\.000Z–2026-11-27T15:42:11\.000Z/);
  match(m, /2 2026-11-27T16:10:00\.000Z–2026-11-27T16:10:30\.000Z/);
  match(m, /3 2026-11-27T17:00:00\.000Z–running/);
  match(
    noPublishingJobMessage({ n: 142, rewrite: true, after: 0, published: 0, jobs: [] }),
    /rewritten .*shape jobs seen: none$/,
  );
  equal(describeShapeJobs([]), 'none');
});
