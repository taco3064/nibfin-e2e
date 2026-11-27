import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { behindProblems, conflictProblems, mergeMethod } from '../../scenarios/lifecycle/review-rebase.ts';
import type { RebaseEvidence } from '../../scenarios/lifecycle/review-rebase.ts';

const AT = Date.parse('2026-11-27T10:00:00Z');
const iso = (minutes: number) => new Date(AT + minutes * 60_000).toISOString();

const evidence = (extra: Partial<RebaseEvidence> = {}): RebaseEvidence => ({
  issue: 'o/exec#7',
  branch: 'nibfin/issue-7',
  at: AT,
  sha: 'a'.repeat(40),
  delivers: [{ id: 1, started_at: iso(-30) }],
  reviews: [],
  forced: [],
  merged: { number: 8, head: 'b'.repeat(40) },
  descends: false,
  delivered: true,
  ...extra,
});

const force = (minutes: number) => ({ timestamp: iso(minutes), before: 'c'.repeat(40), after: 'd'.repeat(40) });

test('mergeMethod prefers rebase, then squash, then a merge commit', () => {
  equal(mergeMethod({ allow_rebase_merge: true, allow_squash_merge: true, allow_merge_commit: true }), 'rebase');
  equal(mergeMethod({ allow_squash_merge: true, allow_merge_commit: true }), 'squash');
  equal(mergeMethod({ allow_merge_commit: true }), 'merge');
  equal(mergeMethod({}), undefined);
});

test('behindProblems passes a behind PR that merged without a Deliver, force push or rebase', () => {
  deepEqual(behindProblems(evidence({ reviews: [{ id: 3, created_at: iso(5) }], forced: [force(-40)] })), []);
});

test('behindProblems names each Deliver, force push and rebase after main advanced', () => {
  const problems = behindProblems(
    evidence({
      delivers: [{ id: 1, started_at: iso(-30) }, { id: 2, started_at: iso(0), reason: 'rebase' }],
      forced: [force(10)],
      descends: true,
      delivered: false,
    }),
  );
  equal(problems.length, 4);
  match(problems.join('\n'), /did not close with delivered/);
  match(problems.join('\n'), /deliver job 2 \(REASON rebase/);
  match(problems.join('\n'), /nibfin\/issue-7 was force-pushed after main advanced: cccccc.→dddddd. at/);
  match(problems.join('\n'), /descends from a{40}/);
});

test('behindProblems needs a merged PR', () => {
  match(behindProblems(evidence({ merged: undefined })).join('\n'), /has no merged PR/);
});

test('conflictProblems passes review, then Deliver, a force push and a merged head over the commit', () => {
  const ok = evidence({
    delivers: [{ id: 1, started_at: iso(-30) }, { id: 2, started_at: iso(12) }],
    reviews: [{ id: 3, created_at: iso(-20) }, { id: 4, created_at: iso(5) }],
    forced: [force(20)],
    descends: true,
  });
  deepEqual(conflictProblems(ok), []);
});

test('conflictProblems requires a review run between the conflict and the Deliver', () => {
  const late = evidence({
    delivers: [{ id: 2, started_at: iso(12) }],
    reviews: [{ id: 3, created_at: iso(-20) }, { id: 4, created_at: iso(15) }],
    forced: [force(20)],
    descends: true,
  });
  deepEqual(conflictProblems(late), ['no review run of o/exec#7 was created between the conflicting commit and deliver job 2 (started ' + iso(12) + ')']);
});

test('conflictProblems names a missing Deliver, force push, descent and delivery', () => {
  const problems = conflictProblems(evidence({ forced: [force(-5)], delivered: false }));
  equal(problems.length, 4);
  match(problems[0] as string, /no deliver job for o\/exec#7 started after the conflicting commit/);
  match(problems[1] as string, /was not force-pushed/);
  match(problems[2] as string, /does not descend from the conflicting commit/);
  match(problems[3] as string, /did not close with delivered/);
});
