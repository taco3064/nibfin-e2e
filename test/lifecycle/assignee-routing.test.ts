// assignee-routing (Issue #468): whether M2's deliver job started under pause, or after a
// removal of pause that was not the scenario's own (R4.12, R4.26).
import { equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { pausedDeliverProblem } from '../../scenarios/lifecycle/phase2-fixtures.ts';
import type { PauseEvent } from '../../scenarios/lifecycle/phase2-fixtures.ts';

const at = (iso: string) => Date.parse(iso);
const added: PauseEvent = { event: 'labeled', actor: 'nibfin-owner', at: at('2026-11-27T10:00:00Z') };
const ownRemoval = { wasOn: true, before: at('2026-11-27T10:10:00Z'), after: at('2026-11-27T10:10:01Z') };
const ownEvent: PauseEvent = { event: 'unlabeled', actor: 'nibfin-owner', at: at('2026-11-27T10:10:00Z') };

test('a deliver job that started after the scenario removed pause passes on to the routing checks', () => {
  equal(pausedDeliverProblem(at('2026-11-27T10:12:00Z'), [ownEvent, added], ownRemoval), undefined);
});

test('a deliver job that started while pause was on fails R4.12/R4.26 naming the start, the events and the tolerance', () => {
  const p = pausedDeliverProblem(at('2026-11-27T10:05:00Z'), [added, ownEvent], ownRemoval);
  match(p ?? '', /started at 2026-11-27T10:05:00\.000Z while pause was on/);
  match(p ?? '', /labeled by nibfin-owner at 2026-11-27T10:00:00\.000Z; unlabeled by nibfin-owner at 2026-11-27T10:10:00\.000Z/);
  match(p ?? '', /5 s tolerance/);
});

test('a deliver job that started after another actor removed pause fails naming that actor and time', () => {
  const other: PauseEvent = { event: 'unlabeled', actor: 'someone-else', at: at('2026-11-27T10:03:00Z') };
  const p = pausedDeliverProblem(at('2026-11-27T10:04:00Z'), [added, other], { wasOn: false, before: at('2026-11-27T10:10:00Z'), after: at('2026-11-27T10:10:01Z') });
  match(p ?? '', /removed by someone-else at 2026-11-27T10:03:00\.000Z, not by the scenario/);
  match(p ?? '', /saw pause already off just before its own removal/);
});

test('a deliver job that started within the tolerance after the own removal passes', () => {
  equal(pausedDeliverProblem(at('2026-11-27T10:10:03Z'), [added, ownEvent], ownRemoval), undefined);
});

test('a deliver job that started within the tolerance before the own removal counts in the product\'s favor', () => {
  equal(pausedDeliverProblem(at('2026-11-27T10:09:57Z'), [added, ownEvent], ownRemoval), undefined);
});

test('a removal in the own window does not count as the scenario\'s when pause was already off before it', () => {
  const p = pausedDeliverProblem(at('2026-11-27T10:12:00Z'), [added, ownEvent], { ...ownRemoval, wasOn: false });
  match(p ?? '', /removed by nibfin-owner at 2026-11-27T10:10:00\.000Z, not by the scenario/);
});
