import { correlateWake, correlateNoAssignee } from '../wake-correlation.mjs';
import { wakeFixture } from './wake-fixtures.mjs';

export function exercise(leg) {
  const check = (fixture, expectedState) => ({ expectedState,
    actual: correlateWake(leg, fixture.expected, fixture.evidence, 'fixture') });
  const status = leg === 'action' ? 'denied' : 'completed';
  const results = [check(wakeFixture(leg, status), 'passed')];
  const denied = wakeFixture(leg, 'denied');
  results.push(check(denied, 'passed'));
  for (const field of ['repository', 'runRepository', 'issue', 'runId',
    'attempt', 'jobId',
    'invocation', 'stage', 'status', 'code']) {
    const fixture = wakeFixture(leg, status);
    fixture.evidence.core[0][field] = 'mismatch';
    results.push(check(fixture, 'unverified'));
  }
  for (const key of ['issue', 'run', 'jobs', 'core']) {
    const fixture = wakeFixture(leg, status);
    delete fixture.evidence[key];
    results.push(check(fixture, 'unverified'));
  }
  const duplicate = wakeFixture(leg, status);
  duplicate.evidence.core.push(structuredClone(duplicate.evidence.core[0]));
  results.push(check(duplicate, 'unverified'));
  if (leg === 'shared-issue') {
    for (const key of ['enrollment', 'forwarding', 'oidc']) {
      const fixture = wakeFixture(leg);
      delete fixture.evidence[key];
      results.push(check(fixture, 'unverified'));
    }
    for (const mutate of [
      e => { e.run.data.repository.id++; },
      e => { e.run.data.actor.id++; },
      e => { e.run.data.head_sha = 'f'.repeat(40); },
      e => { e.forwarding.runId++; },
      e => { e.enrollment.targetRunnerCount++; },
      e => { e.oidc.checkRunId++; },
      e => { e.permission = 'unavailable'; },
    ]) {
      const fixture = wakeFixture(leg);
      mutate(fixture.evidence);
      results.push(check(fixture, 'unverified'));
    }
    results.push(check(wakeFixture(leg, 'pending'), 'unverified'));
    const fixture = wakeFixture(leg);
    fixture.evidence.route = { ...fixture.expected, decision: 'no-eligible-assignee',
      forwarded: false };
    delete fixture.evidence.wake;
    fixture.evidence.core = [];
    results.push({ expectedState: 'passed', actual: correlateNoAssignee(
      fixture.expected, fixture.evidence, 'fixture') });
    delete fixture.evidence.route;
    results.push({ expectedState: 'unverified', actual: correlateNoAssignee(
      fixture.expected, fixture.evidence, 'fixture') });
  } else {
    const skipped = wakeFixture(leg, status);
    skipped.evidence.action.executed = false;
    results.push(check(skipped, 'unverified'));
  }
  return results;
}
export function verify(results) {
  return Array.isArray(results) && results.length >= 15 && results.every(row =>
    row.actual.mode === 'fixture' && row.actual.state === row.expectedState);
}
