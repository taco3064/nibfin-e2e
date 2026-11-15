import { assertWriterHistory, assertConcurrency } from './concurrency-assertions.mjs';
import { positive, identifier, same } from './delivery-contract.mjs';

const time = n => Number.isSafeInteger(n) && n >= 0;
const unknown = code => ({ state: 'unverified', code });
const failed = code => ({ state: 'failed', code });
export const pressureCases = Object.freeze(['healthy', 'serial', 'expired',
  'recovered', 'pending']);
export const diagnosticCodes = Object.freeze(['WSL_CONNECTION_TIMEOUT',
  'JOB_VM_EXEC_INITIALIZE_TIMEOUT', 'JOB_VM_HOST_MEMORY_PRESSURE']);

const executionKeys = ['runRepository', 'runId', 'attempt', 'jobId'];
export const validPressureBinding = b => b && identifier(b.experimentId) &&
  identifier(b.requestId) && identifier(b.clockId) && b.case === 'pressure' &&
  pressureCases.includes(b.phase) && positive(b.memberId) &&
  /^[\w.-]+\/[\w.-]+$/.test(b.repository ?? '') &&
  Array.isArray(b.issues) && b.issues.length > 0 && b.issues.every(positive) &&
  new Set(b.issues).size === b.issues.length;

// Complete histories are supplied by the experiment, never inferred from Job status.
export function observePressure(binding, evidence) {
  if (!validPressureBinding(binding) ||
      evidence?.experimentId !== binding.experimentId ||
      evidence.clockId !== binding.clockId ||
      evidence.phase !== binding.phase || evidence.complete !== true) {
    return unknown('PRESSURE_BINDING_REQUIRED');
  }
  const history = assertWriterHistory(binding, evidence);
  if (history.state !== 'passed') return history;
  const { samples, diagnostics, writers, coverage } = evidence;
  const inside = at => time(at) && at >= coverage.start && at <= coverage.end;
  const bound = event => event && event.experimentId === binding.experimentId &&
    event.clockId === binding.clockId && inside(event.at) &&
    evidence.admissions.some(a => same(a, event, executionKeys));
  if (!Array.isArray(samples) || !samples.length || samples.length > 1000 ||
      samples.some(s => !bound(s) || !['parallel', 'serial', 'wait'].includes(s.mode)) ||
      !Array.isArray(diagnostics) || diagnostics.length > 1000 ||
      diagnostics.some(d => !bound(d) || !diagnosticCodes.includes(d.code) ||
        !time(d.elapsedMs) || !Number.isSafeInteger(d.handshakeAttempt) ||
        d.handshakeAttempt < 0 || d.elapsedMs > d.at - coverage.start)) {
    return unknown('PRESSURE_TIMELINE_REQUIRED');
  }
  if (evidence.admissions.some(a => a.memberId !== binding.memberId) ||
      samples.some(a => samples.some(b => same(a, b, executionKeys) &&
        a.at === b.at && a.mode !== b.mode))) {
    return unknown('CONFLICTING_PRESSURE_HISTORY');
  }
  const unique = [...new Map(writers.map(w => [w.executionId, w])).values()];
  const admissionSample = w => samples.filter(s =>
    same(s, w, executionKeys) && s.at <= w.start)
    .sort((a, b) => b.at - a.at)[0];
  if (unique.some(w => !admissionSample(w) ||
      admissionSample(w).mode === 'wait')) {
    return unknown('ADMISSION_SAMPLE_REQUIRED');
  }
  for (const d of diagnostics) {
    if (d.code === 'JOB_VM_HOST_MEMORY_PRESSURE') {
      if (d.executionId !== null || d.handshakeAttempt !== 0 ||
          unique.some(w => same(w, d, executionKeys))) {
        return unknown('PRESSURE_EXPIRY_IDENTITY_REQUIRED');
      }
    } else {
      const w = unique.find(w => w.executionId === d.executionId);
      if (!w || !same(w, d, executionKeys) || d.at < w.start ||
          d.at > (w.end ?? w.activeUntil) || d.elapsedMs > d.at - w.start ||
          d.handshakeAttempt < 1) {
        return unknown('HANDSHAKE_EXECUTION_REQUIRED');
      }
    }
  }
  if (evidence.admissions.some(a => !unique.some(w =>
      same(a, w, executionKeys)) && !diagnostics.some(d =>
      same(a, d, executionKeys) && d.code === 'JOB_VM_HOST_MEMORY_PRESSURE'))) {
    return unknown('INCOMPLETE_PRESSURE_ADMISSIONS');
  }
  if (diagnostics.some(a => diagnostics.some(b => a !== b &&
      same(a, b, [...executionKeys, 'executionId', 'handshakeAttempt', 'code']) &&
      !same(a, b, ['at', 'elapsedMs', 'code'])))) {
    return unknown('CONFLICTING_DIAGNOSTICS');
  }
  if (unique.some(w => w.end === null) || evidence.effects !== 'reconciled') {
    return unknown('PENDING_TERMINATION_OR_EFFECTS');
  }
  for (const w of unique) {
    const sample = admissionSample(w);
    if (sample?.mode !== 'serial') continue;
    if (unique.some(p => p.executionId !== w.executionId &&
        p.start < w.end && w.start < p.end)) return failed('SERIAL_WRITERS_OVERLAP');
  }
  if (binding.phase === 'pending') return unknown('PENDING_NOT_DEMONSTRATED');
  if (binding.phase === 'expired') {
    const waits = samples.filter(s => s.mode === 'wait');
    const expiry = diagnostics.find(d => d.code === 'JOB_VM_HOST_MEMORY_PRESSURE');
    if (!expiry || waits.length < 2 || waits.length !== samples.length ||
        unique.length ||
        evidence.waitBoundMs !== 300000 ||
        expiry.elapsedMs !== evidence.waitBoundMs ||
        !waits.every(s => same(s, expiry, executionKeys) && s.at <= expiry.at) ||
        Math.min(...waits.map(s => s.at)) !== expiry.at - expiry.elapsedMs ||
        new Set(waits.map(s => s.at)).size < 2) {
      return unknown('BOUNDED_PRESSURE_EXPIRY_REQUIRED');
    }
  } else if (binding.phase === 'serial') {
    if (unique.length < 2 || !unique.some(w => admissionSample(w).mode === 'serial')) {
      return unknown('SERIAL_ADMISSION_REQUIRED');
    }
  } else {
    if (binding.phase === 'recovered') {
      const recovery = assertConcurrency({ ...binding, case: 'interrupted',
        issues: [binding.issues[0]] }, { ...evidence, case: 'interrupted',
        issues: [binding.issues[0]],
        admissions: evidence.admissions.filter(a => a.issue === binding.issues[0]),
        writers: writers.filter(w => w.issue === binding.issues[0]) });
      if (recovery.state !== 'passed') return recovery;
      const replacement = unique.find(w =>
        w.executionId === evidence.recovery.replacement);
      if (!samples.some(s => same(s, replacement, executionKeys) &&
          s.mode === 'wait' && s.at < replacement.start) ||
          !unique.some(w => w.issue !== replacement.issue &&
          w.start < replacement.end && replacement.start < w.end &&
          admissionSample(w).mode === 'parallel')) {
        return unknown('HEALTHY_RECOVERY_REQUIRED');
      }
    }
    const pair = unique.some(a => unique.some(b => a.issue !== b.issue &&
      a.start < b.end && b.start < a.end && [a, b].every(w =>
        admissionSample(w).mode === 'parallel')));
    if (!pair || evidence.independentEligible !== true) {
      return unknown('HEALTHY_PARALLEL_ADMISSION_REQUIRED');
    }
  }
  return { state: 'passed', code: 'PRESSURE_OBSERVED' };
}
