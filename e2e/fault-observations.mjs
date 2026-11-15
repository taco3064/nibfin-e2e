import { same, validAdmission, identifier } from './delivery-contract.mjs';
import { assertWriterHistory } from './concurrency-assertions.mjs';

export const faultCases = Object.freeze(['duplicate-continuation', 'failed-ci',
  'cancelled-writer', 'revoked-wake', 'unknown-termination', 'unknown-write',
  'completed-attempt']);
export const faultKeys = ['requestId', 'repository', 'issue', 'operationId', 'case'];
const result = (state, code) => ({ state, code });

// Observations describe Core decisions; this module never makes those decisions.
export function faultObservation(binding, evidence, phase) {
  const unknown = code => result('unverified', code);
  if (!same(evidence, binding, faultKeys) || evidence.complete !== true ||
      !validAdmission(evidence.execution) ||
      !same(evidence.execution, binding.wake,
        ['runRepository', 'runId', 'attempt', 'jobId'])) {
    return unknown('FAULT_IDENTITY_UNVERIFIED');
  }
  const history = assertWriterHistory({ ...binding, issues: [binding.issue] },
    evidence.history);
  if (history.state !== 'passed') return history;
  if (!evidence.history.writers.some(w => same(w, binding.wake,
      ['runRepository', 'runId', 'attempt', 'jobId'])) ||
      evidence.history.admissions.some(a => a.memberId !== binding.memberId)) {
    return unknown('FAULT_WRITER_UNVERIFIED');
  }
  if (evidence.status === 'queued' || evidence.status === 'capacity') {
    return unknown('FAULT_NOT_DEMONSTRATED');
  }
  if (evidence.fault !== binding.case || evidence.demonstrated !== true) {
    return unknown('FAULT_NOT_DEMONSTRATED');
  }
  if (evidence.termination !== 'confirmed' || evidence.effects !== 'reconciled' ||
      evidence.history.writers.some(w => w.end === null)) {
    return unknown(evidence.termination !== 'confirmed'
      ? 'TERMINATION_UNKNOWN' : 'WRITE_EFFECT_UNKNOWN');
  }
  if (!Number.isSafeInteger(evidence.settledAt) ||
      evidence.settledAt > evidence.history.coverage.end ||
      evidence.history.writers.some(w => w.end > evidence.settledAt)) {
    return unknown('SETTLEMENT_TIME_UNVERIFIED');
  }
  if (evidence.authority === 'revoked') return unknown('WAKE_REVOKED');
  if (evidence.authority !== 'continuing' || evidence.dependenciesReady !== true) {
    return unknown('CONTINUATION_NOT_AUTHORIZED');
  }
  if (!Array.isArray(evidence.committedEffects) ||
      !evidence.committedEffects.every(identifier) ||
      new Set(evidence.committedEffects).size !== evidence.committedEffects.length) {
    return unknown('COMMITTED_EFFECTS_UNVERIFIED');
  }
  if (phase === 'before' && binding.case === 'completed-attempt' &&
      evidence.completedWorkVerified !== true) {
    return unknown('COMPLETED_WORK_UNVERIFIED');
  }
  if (phase !== 'before') {
    if (!validAdmission(evidence.resumedJob) ||
        !identifier(evidence.reason) ||
        !evidence.reason.startsWith(`${binding.case}:`) ||
        evidence.remainingOnly !== true ||
        evidence.completedWorkVerified !== true) {
      return unknown('RECOVERY_UNVERIFIED');
    }
  }
  return result('passed', 'FAULT_OBSERVED');
}

export function repeatedEffects(before, after) {
  return JSON.stringify([...before.committedEffects].sort()) ===
    JSON.stringify([...after.committedEffects].sort());
}

export function extendsHistory(previous, next) {
  const before = previous.history, after = next.history;
  return after.coverage.start <= before.coverage.start &&
    after.coverage.end >= before.coverage.end &&
    after.writers.every(w => before.writers.some(p => p.executionId === w.executionId) ||
      w.start >= previous.settledAt) && before.writers.every(w =>
      after.writers.some(n => same(n, w, ['executionId', 'issue',
        'runRepository', 'runId', 'attempt', 'jobId', 'memberId', 'start', 'end'])));
}

export function compatibleHistory(prior, final, issue) {
  if (!final?.coverage || !Array.isArray(final.writers)) return false;
  const start = Math.max(prior.coverage.start, final.coverage.start);
  const end = Math.min(prior.coverage.end, final.coverage.end);
  if (start >= end) return false;
  const intersects = w => w.issue === issue && w.start < end && w.end > start;
  const before = prior.writers.filter(intersects);
  const after = final.writers.filter(intersects);
  const keys = ['executionId', 'issue', 'runRepository', 'runId', 'attempt',
    'jobId', 'runnerId', 'memberId', 'start', 'end', 'activeUntil'];
  return before.length > 0 && before.length === after.length &&
    before.every(w => after.some(n => same(n, w, keys)));
}
