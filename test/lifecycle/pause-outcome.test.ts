// How the Shape running when `pause` was added ended (Issue #466, Proposal R4.12, R3.38).
import { deepEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { pauseOutcome } from '../../scenarios/lifecycle/journeys.ts';

const open = { open: true, labels: ['scope', 'pause'], shapedAddedWhilePaused: false };

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

test('no shaped, never added, is the held outcome', () => {
  deepEqual(pauseOutcome(open), { kind: 'held' });
});
