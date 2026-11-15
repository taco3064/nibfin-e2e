import { matches } from './github-resources.mjs';

export const admissionCases = Object.freeze([
  'unauthorized-workflow', 'wrong-job', 'wrong-runner', 'wrong-source',
  'fork', 'route',
]);
export const canaryCases = Object.freeze([
  'peer-registration', 'controller-credentials', 'host-path', 'docker', 'egress',
]);
const id = v => Number.isSafeInteger(v) && v > 0;
const text = v => typeof v === 'string' && /^[\w./:@-]{1,256}$/.test(v);
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const equal = (a, b, keys) => keys.every(k => a?.[k] === b?.[k]);
const identityKeys = ['repository', 'runId', 'attempt', 'jobId', 'runnerId',
  'runnerName', 'workflowId', 'workflowPath', 'sha', 'event', 'headRepository'];
export function validAssignment(e) {
  return e && ['runId', 'attempt', 'jobId', 'runnerId', 'workflowId'].every(
    k => id(e[k])) && ['repository', 'runnerName', 'workflowPath', 'event',
    'headRepository'].every(k => text(e[k])) && /^[a-f\d]{40}$/.test(e.sha ?? '');
}
function native(expected, observation) {
  const { run, jobs } = observation ?? {};
  const target = { repository: expected.repository, runId: expected.runId,
    attempt: expected.attempt, sha: expected.sha };
  if (run?.complete !== true || jobs?.complete !== true ||
      !equal(run.target, target, Object.keys(target)) ||
      !equal(jobs.target, target, Object.keys(target)) ||
      run.target.kind !== 'run' || jobs.target.kind !== 'jobs' ||
      !matches(run.data, { ...target, kind: 'run' }) ||
      !Array.isArray(jobs.data) || jobs.data.length > 1000 ||
      !jobs.data.every(j => matches(j, { ...target, kind: 'jobs' })) ||
      new Set(jobs.data.map(j => j.id)).size !== jobs.data.length) return null;
  const job = jobs.data.find(j => j.id === expected.jobId);
  const r = run.data;
  const actual = { repository: r.repository?.full_name, runId: r.id,
    attempt: r.run_attempt, jobId: job?.id, runnerId: job?.runner_id,
    runnerName: job?.runner_name, workflowId: r.workflow_id,
    workflowPath: r.path, sha: r.head_sha, event: r.event,
    headRepository: r.head_repository?.full_name };
  return { actual, job, run: r };
}
function sentinel(expected, actual, state) {
  return text(expected?.run) && text(expected?.nonce) &&
    equal(expected, actual, ['run', 'nonce']) && actual?.state === state;
}
function slot(expected, actual) {
  return ['hostId', 'slotId'].every(k => text(expected?.[k])) &&
    ['runnerId', 'memberId', 'repositoryId'].every(k => id(expected?.[k])) &&
    equal(expected, actual,
      ['hostId', 'slotId', 'runnerId', 'memberId', 'repositoryId']);
}

// Pure comparison: inputs are evidence, never authority to run a probe.
export function compareAdmission(expected, observed, mode = 'synthetic') {
  const answer = (state, code, actual = null) => ({ mode, state, code,
    case: admissionCases.includes(expected?.case) ? expected.case : null,
    expected: validAssignment(expected?.negative) ?
      Object.fromEntries(identityKeys.map(k => [k, expected.negative[k]])) : null,
    actual: actual ? Object.fromEntries(identityKeys.map(k => [k,
      typeof actual[k] === 'number' ? actual[k] :
        text(actual[k]) ? actual[k] : null])) : null,
  });
  if (!admissionCases.includes(expected?.case) ||
      !['synthetic', 'live'].includes(mode)) return answer('unverified', 'CASE_UNKNOWN');
  if (expected.applicable === false && ['fork', 'route'].includes(expected.case)) {
    return answer('inapplicable', 'CASE_INAPPLICABLE');
  }
  if (expected.applicable !== true || !validAssignment(expected.negative) ||
      !validAssignment(expected.eligible)) return answer('unverified', 'ASSIGNMENT');
  const n = native(expected.negative, observed?.negative);
  if (!n || !equal(n.actual, expected.negative, identityKeys)) {
    return answer('unverified', 'NATIVE_IDENTITY', n?.actual);
  }
  const fail = (state, code) => answer(state, code, n.actual);
  const steps = n.job.steps;
  if (Array.isArray(steps) && steps.some(s => s?.started_at != null ||
      ['in_progress', 'completed'].includes(s?.status) &&
      s?.conclusion !== 'skipped')) return fail('failing', 'NEGATIVE_STEP_EXECUTED');
  if (sentinel(expected.negativeSentinel, observed?.negativeSentinel, 'present')) {
    return fail('failing', 'NEGATIVE_SENTINEL_PRESENT');
  }
  // Empty native steps is deliberate. Missing, skipped or malformed readback
  // cannot silently stand in for a zero-execution observation.
  if (!Array.isArray(steps) || steps.length !== 0 ||
      n.job.status !== 'completed' || n.run.status !== 'completed' ||
      !['failure', 'cancelled'].includes(n.job.conclusion) ||
      !['failure', 'cancelled'].includes(n.run.conclusion)) {
    return fail('unverified', 'ZERO_STEPS_UNPROVEN');
  }
  const r = observed.rejection;
  if (r?.verified !== true || r.category !== expected.case ||
      !equal(r.assignment, expected.negative, identityKeys) ||
      !time(r.rejectedAt) || !text(r.reference)) {
    return fail('unverified', 'REJECTION_UNPROVEN');
  }
  if (!sentinel(expected.negativeSentinel, observed.negativeSentinel, 'absent')) {
    return fail('unverified', 'SENTINEL_UNAVAILABLE');
  }
  const e = native(expected.eligible, observed.eligible);
  if (!e || !equal(e.actual, expected.eligible, identityKeys) ||
      !slot(expected.slot, observed.negativeSlot) ||
      !slot(expected.slot, observed.eligibleSlot) ||
      expected.slot.runnerId !== n.actual.runnerId ||
      expected.slot.runnerId !== e.actual.runnerId ||
      expected.negative.runId === expected.eligible.runId ||
      expected.negativeSentinel.run === expected.eligibleSentinel?.run ||
      expected.negativeSentinel.nonce === expected.eligibleSentinel?.nonce) {
    return fail('unverified', 'RECOVERY_BINDING');
  }
  if (!time(e.job.started_at) || Date.parse(e.job.started_at) <=
      Date.parse(r.rejectedAt) || e.job.status !== 'completed' ||
      e.job.conclusion !== 'success' || e.run.status !== 'completed' ||
      e.run.conclusion !== 'success' || !Array.isArray(e.job.steps) ||
      !e.job.steps.some(s => time(s?.started_at) && s?.status === 'completed' &&
        s?.conclusion === 'success') ||
      !sentinel(expected.eligibleSentinel, observed.eligibleSentinel, 'present')) {
    return fail('unverified', 'RECOVERY_UNPROVEN');
  }
  if (observed.terminated !== true || observed.cleaned !== true) {
    return fail('unverified', 'CLEANUP_UNPROVEN');
  }
  return fail(mode === 'live' ? 'passed' : 'synthetic', 'REJECTION_AND_RECOVERY');
}

export function compareCanaries(observations) {
  // Only synthetic tokens are permitted; no credential bytes or host selectors.
  return canaryCases.map(name => {
    const rows = Array.isArray(observations) ?
      observations.filter(row => row?.case === name) : [];
    const row = rows.length === 1 ? rows[0] : null;
    const state = row?.mode === 'synthetic' &&
      ['denied', 'accessible', 'unavailable'].includes(row.observation) ?
      { denied: 'expected-denial', accessible: 'unexpected-access',
        unavailable: 'unavailable' }[row.observation] : 'unavailable';
    return { case: name, mode: 'synthetic', state };
  });
}
