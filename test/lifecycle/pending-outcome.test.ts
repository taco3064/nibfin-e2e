// How the Deliver running when `pending` was added ended, and what `pending` let through
// (Issue #665, Proposal R4.13, R4.10).
import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchedWhilePending, pendingOutcome } from '../../scenarios/lifecycle/journeys.ts';

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
