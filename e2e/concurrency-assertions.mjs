// Pure contracts: supplied observations never establish their own provenance.
import { positive, same } from './delivery-contract.mjs';

export const cases = Object.freeze(['independent', 'duplicate', 'interrupted',
  'offline']);
const result = (state, code) => ({ state, code });
const unknown = code => result('unverified', code);
const failed = code => result('failed', code);
const time = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 200;
const identity = ['issue', 'runRepository', 'runId', 'attempt', 'jobId', 'runnerId'];
export const admissionKey = a => JSON.stringify(identity.map(key => a[key]));
const validAdmission = a => a && positive(a.issue) &&
  /^[\w.-]+\/[\w.-]+$/.test(a.runRepository ?? '') &&
  ['runId', 'attempt', 'jobId', 'runnerId', 'memberId'].every(key => positive(a[key]));

export function assertConcurrency(binding, evidence) {
  if (!binding || !cases.includes(binding.case) ||
      !Array.isArray(binding.issues) ||
      binding.issues.length !== (binding.case === 'independent' ? 2 : 1) ||
      !binding.issues.every(positive) ||
      new Set(binding.issues).size !== binding.issues.length) {
    return unknown('ISSUE_BINDING_REQUIRED');
  }
  if (!evidence || !same(evidence, binding, ['requestId', 'repository', 'case']) ||
      !Array.isArray(evidence.issues) ||
      JSON.stringify(evidence.issues) !== JSON.stringify(binding.issues)) {
    return unknown('EVIDENCE_BINDING_REQUIRED');
  }
  const { admissions, writers, coverage } = evidence;
  if (!Array.isArray(admissions) || !Array.isArray(writers) ||
      admissions.length > 100 || writers.length > 100 ||
      admissions.some(a => !validAdmission(a) || !binding.issues.includes(a.issue)) ||
      new Set(admissions.map(admissionKey)).size !== admissions.length) {
    return unknown('ADMISSION_HISTORY_REQUIRED');
  }
  const unique = new Map();
  for (const w of writers) {
    if (!w || !text(w.executionId) || !validAdmission(w) ||
        !admissions.some(a => same(w, a, [...identity, 'memberId'])) ||
        !time(w.start) || !time(w.activeUntil) || w.activeUntil < w.start ||
        !(w.end === null || time(w.end) && w.end >= w.activeUntil)) {
      return unknown('WRITER_IDENTITY_REQUIRED');
    }
    const old = unique.get(w.executionId);
    if (old && !same(w, old, [...identity, 'memberId', 'start', 'end',
      'activeUntil'])) {
      return unknown('CONFLICTING_WRITER_HISTORY');
    }
    unique.set(w.executionId, w);
  }
  const executions = [...unique.values()];
  for (const a of executions) for (const b of executions) {
    if (a.issue === b.issue && a.executionId !== b.executionId &&
        a.start < (b.end ?? b.activeUntil) && b.start < (a.end ?? a.activeUntil)) {
      return failed('OVERLAPPING_WRITERS');
    }
  }
  if (!coverage || coverage.admissions !== true || coverage.writers !== true ||
      !time(coverage.start) || !time(coverage.end) ||
      coverage.end <= coverage.start || executions.some(w =>
        w.start < coverage.start || w.activeUntil > coverage.end ||
        w.start > coverage.end ||
        w.end !== null && w.end > coverage.end)) {
    return unknown('COMPLETE_PROTECTED_HISTORY_REQUIRED');
  }
  if (binding.case === 'independent') {
    if (binding.issues.length !== 2 || new Set(binding.issues).size !== 2 ||
        !positive(evidence.capacity) || evidence.capacity < 2 ||
        evidence.independentEligible !== true) {
      return unknown('INDEPENDENT_CAPACITY_REQUIRED');
    }
    const progress = evidence.progress;
    if (!Array.isArray(progress) || progress.length !== 2 ||
        !binding.issues.every(issue => progress.some(p => p?.issue === issue)) ||
        progress.some(p => !p || !time(p.at) || !time(p.unfinishedUntil) ||
          p.at < coverage.start || p.unfinishedUntil > coverage.end ||
          p.at >= p.unfinishedUntil || !executions.some(w => w.issue === p.issue &&
            w.start <= p.at && ((w.end ?? w.activeUntil) >= p.at)))) {
      return unknown('PAIRED_PROGRESS_REQUIRED');
    }
    if (progress.some(p => p.at >= progress.find(q => q.issue !== p.issue)
      .unfinishedUntil)) return failed('GLOBAL_BARRIER_OBSERVED');
  } else if (binding.case === 'duplicate') {
    // An activity sample is not termination proof for the rest of the window.
    if (executions.some(w => w.end === null && w.activeUntil < coverage.end)) {
      return unknown('COMPLETE_PROTECTED_HISTORY_REQUIRED');
    }
    if (!Array.isArray(evidence.wakes) || evidence.wakes.length !== 2 ||
        !Array.isArray(binding.wakes) || binding.wakes.length !== 2 ||
        new Set(binding.wakes.map(w => w?.wakeId)).size !== 2 ||
        !binding.wakes.every(w => w && text(w.wakeId) &&
          w.issue === binding.issues[0] && evidence.wakes.some(e =>
          same(e, w, ['wakeId', 'issue']) && Array.isArray(e.admissions) &&
          e.admissions.length > 0 && e.admissions.every(key =>
            admissions.some(a => admissionKey(a) === key))))) {
      return unknown('WAKE_ADMISSIONS_REQUIRED');
    }
    const keys = new Set(evidence.wakes.flatMap(w => w.admissions));
    if (admissions.some(a => !keys.has(admissionKey(a))) ||
        executions.length === 0 || admissions.some(a =>
          !executions.some(w => admissionKey(w) === admissionKey(a)) &&
          a.writerDenied !== true)) return unknown('WRITER_COVERAGE_REQUIRED');
  } else if (binding.case === 'interrupted') {
    if (!positive(binding.memberId)) return unknown('MEMBER_BINDING_REQUIRED');
    if (admissions.some(a => a.memberId !== binding.memberId)) {
      return failed('CROSS_MEMBER_ADMISSION');
    }
    const r = evidence.recovery;
    const prior = executions.find(w => w.executionId === r?.prior);
    const next = executions.find(w => w.executionId === r?.replacement);
    if (!prior || !next || prior.executionId === next.executionId ||
        prior.issue !== next.issue) return unknown('RECOVERY_EXECUTIONS_REQUIRED');
    const predecessors = executions.filter(w =>
      w.executionId !== next.executionId && w.start <= next.start);
    if (predecessors.some(w => w.end === null) || r.termination !== 'confirmed' ||
        r.effects !== 'reconciled' || r.authorization !== 'continuing' ||
        !time(r.confirmedAt)) return unknown('PENDING_TERMINATION_OR_EFFECTS');
    if (prior.start > next.start ||
        predecessors.some(w => r.confirmedAt < w.end) ||
        r.confirmedAt > next.start) {
      return failed('UNSAFE_REPLACEMENT');
    }
  } else if (binding.case === 'offline') {
    if (admissions.some(a => a.memberId !== binding.memberId)) {
      return failed('CROSS_MEMBER_ADMISSION');
    }
    const route = evidence.route;
    if (!route || route.offline !== true || route.complete !== true ||
        route.selectedMember !== binding.memberId ||
        !positive(route.retainedMember)) return unknown('OFFLINE_ROUTE_REQUIRED');
    if (route.retainedMember !== binding.memberId) return failed('ROUTE_SWITCHED');
  } else return unknown('CASE_REQUIRED');
  return result('passed', 'CONCURRENCY_CONTRACT_CONFIRMED');
}
