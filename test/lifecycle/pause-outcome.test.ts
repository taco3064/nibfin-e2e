// How the Shape running when `pause` was added ended: only a published Shape passes,
// because the running Shape finishes before `pause` holds P (Issue #466, #715,
// Proposal R4.12, R3.38).
import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { pauseOutcome } from '../../scenarios/lifecycle/journeys.ts';

const shapeJob = {
  id: 5,
  conclusion: 'success',
  started_at: '2026-11-20T10:00:00Z',
  completed_at: '2026-11-20T10:10:00Z',
};
const open = { open: true, labels: ['scope', 'pause'], shapedAddedWhilePaused: false, shapeJob };

test('a closed Issue is a fault', () => {
  deepEqual(
    pauseOutcome({ ...open, open: false, labels: ['scope', 'shaped', 'pause'], shapedAddedWhilePaused: true }),
    { kind: 'fault', reason: 'P closed while pause was on' },
  );
});

test('pending while paused is a fault', () => {
  deepEqual(pauseOutcome({ ...open, labels: ['scope', 'pause', 'pending', 'shaped'] }), {
    kind: 'fault',
    reason: 'P got pending while pause was on',
  });
});

test('shaped while paused is the published outcome', () => {
  deepEqual(pauseOutcome({ ...open, labels: ['scope', 'shaped', 'pause'], shapedAddedWhilePaused: true }), {
    kind: 'published',
  });
});

test('shaped added and then removed while paused is a fault', () => {
  deepEqual(pauseOutcome({ ...open, shapedAddedWhilePaused: true }), {
    kind: 'fault',
    reason: '`shaped` was added and removed while pause was on',
  });
});

test('no shaped, never added, is an R4.12 fault naming the shape job', () => {
  const o = pauseOutcome(open);
  equal(o.kind, 'fault');
  const reason = o.kind === 'fault' ? o.reason : '';
  match(reason, /^R4\.12: the running Shape stopped before publishing: /);
  match(
    reason,
    /shape job 5 completed \(success\) without `shaped` while pause was on \(started 2026-11-20T10:00:00Z, completed 2026-11-20T10:10:00Z\)$/,
  );
});

test('no shaped after a shape job that completed before pause is R4.12 not exercised', () => {
  deepEqual(pauseOutcome({ ...open, late: "P's shape job 5 completed before pause was added" }), {
    kind: 'fault',
    reason: "R4.12: not exercised: P's shape job 5 completed before pause was added, and its Shape was not published",
  });
});

test('a published Shape passes even when the shape job completed before pause', () => {
  deepEqual(pauseOutcome({ ...open, labels: ['scope', 'shaped', 'pause'], late: 'late' }), { kind: 'published' });
});
