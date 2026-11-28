// How the Deliver running when `pending` was added ended, and what `pending` let through
// (Issue #665, Proposal R4.13, R4.10).
import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { branchPr, dispatchedWhilePending, pendingOutcome, prTestFault, prTestState } from '../../scenarios/lifecycle/journeys.ts';

const done = {
  id: 7,
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-11-20T10:00:00Z',
  completed_at: '2026-11-20T10:20:00Z',
};
const base = {
  sendBackExpected: false,
  sentBack: false,
  pr: false,
  open: true,
  shaped: true,
  job: done,
  runCompleted: true,
};

test('a deliver job that succeeded in a completed run without a PR is held on that first judgment', () => {
  deepEqual(pendingOutcome(base), { kind: 'held', completedAt: Date.parse(done.completed_at) });
  deepEqual(pendingOutcome({ ...base, sendBackExpected: true }), {
    kind: 'held',
    completedAt: Date.parse(done.completed_at),
  });
});

test('a running job or an unfinished run keeps the wait going', () => {
  equal(pendingOutcome({ ...base, job: { ...done, status: 'in_progress', conclusion: null, completed_at: null } }), undefined);
  equal(pendingOutcome({ ...base, runCompleted: false }), undefined);
});

test('a PR for the branch is the pr outcome', () => {
  deepEqual(pendingOutcome({ ...base, pr: true }), { kind: 'pr' });
  deepEqual(pendingOutcome({ ...base, pr: true, runCompleted: false, job: { ...done, status: 'in_progress' } }), {
    kind: 'pr',
  });
});

test('shaped removed after the edit is sent back only when a send-back is expected', () => {
  deepEqual(pendingOutcome({ ...base, sendBackExpected: true, sentBack: true, shaped: false }), { kind: 'sent back' });
  deepEqual(pendingOutcome({ ...base, sentBack: true, shaped: false }), {
    kind: 'fault',
    reason: 'P lost shaped while pending was on, with no send-back expected',
  });
});

test('without a confirmed send-back, a missing shaped on the first Deliver keeps waiting', () => {
  equal(pendingOutcome({ ...base, sendBackExpected: true, shaped: false }), undefined);
});

test('a deliver job that failed while pending was on is a named fault', () => {
  const o = pendingOutcome({ ...base, job: { ...done, conclusion: 'failure' } });
  equal(o?.kind, 'fault');
  match(
    o?.kind === 'fault' ? o.reason : '',
    /deliver job 7 completed with failure while pending was on \(started 2026-11-20T10:00:00Z, completed 2026-11-20T10:20:00Z\)/,
  );
});

test('P closed while pending was on is a fault', () => {
  deepEqual(pendingOutcome({ ...base, open: false }), { kind: 'fault', reason: 'P closed while pending was on' });
});

test('runs created while pending was on, other than the held one, are named', () => {
  const pendingAt = Date.parse('2026-11-20T10:05:00Z');
  const runs = [
    { id: 1, stage: 'deliver' as const, created_at: '2026-11-20T09:59:00Z' },
    { id: 2, stage: 'deliver' as const, created_at: '2026-11-20T10:06:00Z' },
    { id: 3, stage: 'review' as const, created_at: '2026-11-20T10:07:00Z' },
    { id: 4, stage: 'deliver' as const, created_at: '2026-11-20T10:05:30Z' },
  ];
  deepEqual(dispatchedWhilePending(runs, pendingAt, 4), [
    'deliver run 2 created 2026-11-20T10:06:00Z',
    'review run 3 created 2026-11-20T10:07:00Z',
  ]);
});

test('no run created while pending was on passes', () => {
  deepEqual(dispatchedWhilePending([], 0, 1), []);
  deepEqual(
    dispatchedWhilePending([{ id: 1, stage: 'deliver', created_at: '2026-11-20T09:59:00Z' }], Date.parse('2026-11-20T10:05:00Z'), 9),
    [],
  );
});

// Only an open PR is P's PR once `pending` is on, and the PR test wait ends with a named
// reason when it can no longer succeed (Issue #684, Proposal R4.13, R4.10, R1.14).
const pull = (number: number, state: string, ref = 'nibfin/issue-9', merged_at: string | null = null) => ({
  number,
  state,
  merged_at,
  merge_commit_sha: null,
  created_at: '2026-11-20T10:00:00Z',
  head: { ref, sha: `sha${number}` },
  base: { ref: 'main' },
  user: null,
  body: null,
  html_url: '',
});

test('a closed PR for the branch is not P’s open PR, but is found in any state', () => {
  const closed = pull(3, 'closed');
  equal(branchPr([closed], 9, true), undefined);
  equal(branchPr([closed], 9, false), closed);
});

test('an open PR for the branch is P’s PR; another branch’s PR never is', () => {
  const open = pull(4, 'open');
  equal(branchPr([pull(5, 'open', 'nibfin/issue-10'), open], 9, true), open);
  equal(branchPr([pull(5, 'open', 'nibfin/issue-10')], 9, false), undefined);
  equal(branchPr(undefined, 9, false), undefined);
});

const wait = {
  n: 9,
  pr: undefined,
  testCompleted: false,
  deliverRuns: [{ status: 'completed' }],
  pendingOn: true,
  pendingReason: '#9 has pending; repair record class not recognised',
};

test('no open PR, the Deliver completed and an untolerated pending on ends the test wait', () => {
  const r = prTestFault(wait);
  match(r ?? '', /^P has no open PR for nibfin\/issue-9, its Deliver completed and pending is still on/);
  match(r ?? '', /Proposal R4\.13\): #9 has pending; repair record class not recognised$/);
  match(prTestFault({ ...wait, deliverRuns: [] }) ?? '', /no open PR/);
});

test('a Deliver still running, or a pending the repair stage may clear, keeps the test wait going', () => {
  equal(prTestFault({ ...wait, deliverRuns: [{ status: 'completed' }, { status: 'in_progress' }] }), undefined);
  equal(prTestFault({ ...wait, deliverRuns: [{ status: 'queued' }] }), undefined);
  equal(prTestFault({ ...wait, pendingReason: undefined }), undefined);
});

test('the R4.13 reason is never given with pending off or P closed', () => {
  equal(prTestFault({ ...wait, pendingOn: false }), undefined);
  equal(prTestFault({ ...wait, pendingOn: false, pendingReason: undefined }), undefined);
});

test('a PR seen open and closed or merged before its test completed ends the test wait', () => {
  equal(prTestFault({ ...wait, pr: pull(4, 'closed') }), "P's PR #4 was closed before its test check completed");
  equal(
    prTestFault({ ...wait, pendingOn: false, pr: pull(4, 'closed', 'nibfin/issue-9', '2026-11-20T11:00:00Z') }),
    "P's PR #4 was merged before its test check completed",
  );
  equal(prTestFault({ ...wait, pr: pull(4, 'closed'), testCompleted: true, pendingOn: false }), undefined);
});

test('an open PR keeps the test wait going', () => {
  equal(prTestFault({ ...wait, pr: pull(4, 'open') }), undefined);
});

test('the state line names the PR, its state, head and test check', () => {
  equal(prTestState(9, pull(4, 'open'), undefined), 'PR #4 open, head sha4: no test check on that head');
  equal(
    prTestState(9, pull(4, 'open'), { status: 'in_progress', conclusion: null }),
    'PR #4 open, head sha4: test in_progress/none',
  );
  equal(
    prTestState(9, pull(4, 'open'), { status: 'completed', conclusion: 'failure' }),
    'PR #4 open, head sha4: test completed/failure',
  );
  equal(prTestState(9, pull(4, 'open'), { error: 'HTTP 502' }), 'PR #4 open, head sha4: test check unread (HTTP 502)');
});

test('a closed or merged PR the wait never saw open is named, never as no PR', () => {
  const closed = branchPr([pull(3, 'closed')], 9, false);
  equal(prTestState(9, closed, undefined), 'PR #3 closed, head sha3: no test check on that head');
  const merged = branchPr([pull(3, 'closed', 'nibfin/issue-9', '2026-11-20T11:00:00Z')], 9, false);
  equal(
    prTestState(9, merged, { status: 'completed', conclusion: 'success' }),
    'PR #3 merged, head sha3: test completed/success',
  );
  equal(prTestState(9, undefined, undefined), 'no PR for nibfin/issue-9');
});
