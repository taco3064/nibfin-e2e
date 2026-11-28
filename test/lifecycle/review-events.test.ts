import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import {
  approvalMergeProblems,
  fixDoneAt,
  reviewBody,
  reviewFixProblems,
  reviewProblems,
} from '../../scenarios/lifecycle/review-events.ts';
import type { FixEvidence, FixJob, MergeEvidence } from '../../scenarios/lifecycle/review-events.ts';

const AT = Date.parse('2026-11-27T10:00:00Z');
const iso = (minutes: number) => new Date(AT + minutes * 60_000).toISOString();
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const job = (extra: Partial<FixJob> = {}): FixJob => ({
  id: 5,
  created_at: iso(2),
  completed_at: iso(40),
  status: 'completed',
  conclusion: 'success',
  reason: 'review',
  ...extra,
});

const fix = (extra: Partial<FixEvidence> = {}): FixEvidence => ({
  pr: 8,
  review: { id: 99, submitted_at: iso(0) },
  reviewed: A,
  head: B,
  jobs: [job({ id: 1, created_at: iso(-60), completed_at: iso(-30), reason: undefined }), job()],
  pushes: [{ timestamp: iso(35), activity_type: 'push', after: B }],
  content: 'export function double(n) { return n * 2; }\nexport function half(n) { return n / 2; }\n',
  file: 'src/x.js',
  ...extra,
});

test('the review fix passes with a review-reason deliver job after the review, a push and the asked change', () => {
  deepEqual(reviewFixProblems(fix()), []);
});

test('a missing or early deliver job fails naming the PR, the review and submitted_at', () => {
  const [p] = reviewFixProblems(fix({ jobs: [job({ id: 1, created_at: iso(-60) })] }));
  match(
    p ?? '',
    /no deliver job started after PR #8 review 99 \(submitted 2026-11-27T10:00:00.000Z\); deliver jobs seen: 1 \(created 2026-11-27T09:00:00.000Z\)/,
  );
  match(reviewFixProblems(fix({ jobs: [] }))[0] ?? '', /deliver jobs seen: none/);
});

test('a deliver job after the review that has not completed fails', () => {
  match(
    reviewFixProblems(fix({ jobs: [job({ status: 'in_progress', completed_at: null })] }))[0] ?? '',
    /no deliver job after PR #8 review 99 .* completed: 5 \(in_progress\)/,
  );
});

test('a deliver job with another reason fails', () => {
  deepEqual(reviewFixProblems(fix({ jobs: [job({ reason: 'ci-failure' })] })), [
    'the deliver jobs after PR #8 review 99 (submitted 2026-11-27T10:00:00.000Z) carry REASON ci-failure (job 5), expected review',
  ]);
  match(reviewFixProblems(fix({ jobs: [job({ reason: undefined })] }))[0] ?? '', /REASON unknown \(job 5\)/);
});

test('no push after the review fails', () => {
  deepEqual(
    reviewFixProblems(
      fix({
        pushes: [
          { timestamp: iso(-10), activity_type: 'push', after: A },
          { timestamp: iso(5), activity_type: 'branch_deletion', after: A },
        ],
      }),
    ),
    ['no push to the branch after PR #8 review 99 (submitted 2026-11-27T10:00:00.000Z)'],
  );
});

test('an unchanged head or a head without the asked function fails', () => {
  deepEqual(reviewFixProblems(fix({ head: A })), [`PR #8's head is still the reviewed ${A}`]);
  match(
    reviewFixProblems(
      fix({ content: 'export function double(n) { return n * 2; }\nexport function halve(n) {}\n' }),
    )[0] ?? '',
    /src\/x\.js at the new head b+ has no `half`/,
  );
  match(reviewFixProblems(fix({ content: undefined }))[0] ?? '', /src\/x\.js is missing at the new head/);
});

test('fixDoneAt is the last completion of a deliver job after the review, else the review time', () => {
  equal(fixDoneAt(fix()), AT + 40 * 60_000);
  equal(fixDoneAt(fix({ jobs: [job({ created_at: iso(-60) })] })), AT);
  equal(fixDoneAt(fix({ jobs: [job({ completed_at: null, status: 'in_progress' })] })), AT);
});

const merge = (extra: Partial<MergeEvidence> = {}): MergeEvidence => ({
  pr: 8,
  review: { id: 100, submitted_at: iso(0) },
  fixed: B,
  merged: { number: 8, merged_at: iso(3), head: B },
  delivered: true,
  ...extra,
});

test('the approval passes when the approved head merges after it and the Issue is delivered', () => {
  deepEqual(approvalMergeProblems(merge()), []);
});

test('a merge before the approval, of another head, none, or no delivered fails', () => {
  deepEqual(approvalMergeProblems(merge({ merged: { number: 8, merged_at: iso(-1), head: B } })), [
    `PR #8 merged at ${iso(-1)}, before PR #8 review 100 (submitted ${iso(0)})`,
  ]);
  deepEqual(approvalMergeProblems(merge({ merged: { number: 8, merged_at: iso(3), head: A } })), [
    `PR #8 merged head ${A}, not the approved ${B}`,
  ]);
  deepEqual(approvalMergeProblems(merge({ merged: undefined, delivered: false })), [
    `PR #8 did not merge after PR #8 review 100 (submitted ${iso(0)})`,
    `the Issue did not close with delivered after PR #8 review 100 (submitted ${iso(0)})`,
  ]);
});

test('reviewProblems checks the state, the commit and submitted_at of the created review', () => {
  deepEqual(
    reviewProblems(
      { id: 1, state: 'CHANGES_REQUESTED', commit_id: A, submitted_at: iso(0) },
      'CHANGES_REQUESTED',
      A,
      8,
    ),
    [],
  );
  deepEqual(reviewProblems({ id: 1, state: 'COMMENTED', commit_id: B, submitted_at: null }, 'APPROVED', A, 8), [
    'review 1 on PR #8 has state COMMENTED, expected APPROVED',
    `review 1 on PR #8 is on ${B}, expected ${A}`,
    'review 1 on PR #8 has no submitted_at',
  ]);
});

test('the review body asks for one change in the fixture files', () => {
  const body = reviewBody('e2e-re-r1');
  match(body, /`half\(n\)` from `src\/e2e-re-r1\.js` that returns `n \/ 2`/);
  match(body, /`test\/e2e-re-r1\.test\.js`/);
});
