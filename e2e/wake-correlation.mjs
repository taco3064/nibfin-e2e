import { matches } from './github-resources.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 200;
const same = (actual, expected, keys) => !!actual && keys.every(key =>
  actual[key] === expected[key]);
const issueKeys = ['repository', 'issue', 'originRunId', 'originAttempt'];
const executionKeys = ['repository', 'runRepository', 'issue', 'runId',
  'attempt', 'jobId',
  'invocation', 'stage'];
const decisions = ['completed', 'denied', 'pending'];

function validExpected(expected, leg) {
  return expected && /^[\w.-]+\/[\w.-]+$/.test(expected.repository ?? '') &&
    /^[\w.-]+\/[\w.-]+$/.test(expected.runRepository ?? '') &&
    ['issue', 'runId', 'attempt', 'jobId']
      .every(key => positive(expected[key])) &&
    (leg !== 'shared-issue' || ['originRunId', 'originAttempt']
      .every(key => positive(expected[key]))) &&
    ['invocation', 'stage', 'code'].every(key => text(expected[key])) &&
    decisions.includes(expected.status);
}
function observed(observation, target) {
  return observation?.complete === true &&
    same(observation.target, target, Object.keys(target)) &&
    matches(observation.data, target);
}
function nativeExecution(evidence, expected) {
  const { runRepository: repository, runId, attempt, jobId } = expected;
  if (!observed(evidence.run, { kind: 'run', repository, runId, attempt })) {
    return false;
  }
  const jobs = evidence.jobs;
  const target = { kind: 'jobs', repository, runId, attempt };
  if (jobs?.complete !== true ||
      !same(jobs.target, target, Object.keys(target)) ||
      !Array.isArray(jobs.data) || jobs.data.length > 1000 ||
      !jobs.data.every(job => matches(job, target)) ||
      new Set(jobs.data.map(job => job.id)).size !== jobs.data.length) return false;
  const job = jobs.data.find(job => job.id === jobId);
  return job?.status === 'completed' && typeof job.conclusion === 'string' &&
    evidence.run.data.status === 'completed' &&
    typeof evidence.run.data.conclusion === 'string';
}
function coreResult(evidence, expected) {
  const results = evidence.core;
  // Multiple copies of one result are ambiguous, never multiple admissions.
  return Array.isArray(results) && results.length === 1 &&
    same(results[0], expected, executionKeys.concat(['status', 'code'])) &&
    (expected.status === 'completed'
      ? /^[a-f0-9]{64}$/.test(results[0].receiptHash ?? '')
      : results[0].receiptHash === '');
}
const outcome = (leg, mode, state, code) => ({ leg, mode, state, code });

// These functions consume observations, never resolve routes or grant authority.
// The protected caller obtains Core/wake/Action records from its native evidence.
// Controlled tests must always use mode=fixture; a fixture cannot certify live use.
export function correlateWake(leg, expected, evidence, mode = 'live') {
  const result = (state, code) => outcome(leg, mode, state, code);
  if (!['shared-issue', 'action'].includes(leg) ||
      !['live', 'fixture'].includes(mode) || !validExpected(expected, leg)) {
    return result('unverified', 'INVALID_EXPECTATION');
  }
  if (!evidence || !observed(evidence.issue, { kind: 'issue',
    repository: expected.repository, number: expected.issue })) {
    return result('unverified', 'ISSUE_EVIDENCE_REQUIRED');
  }
  if (!nativeExecution(evidence, expected) || !coreResult(evidence, expected)) {
    return result('unverified', 'EXECUTION_CORRELATION_REQUIRED');
  }
  const nativeJob = evidence.jobs.data.find(item => item.id === expected.jobId);
  if (expected.status === 'completed' &&
      (nativeJob.conclusion !== 'success' ||
        evidence.run.data.conclusion !== 'success')) {
    return result('unverified', 'NATIVE_COMPLETION_REQUIRED');
  }
  if (leg === 'shared-issue') {
    const origin = { kind: 'run', repository: expected.repository,
      runId: expected.originRunId, attempt: expected.originAttempt };
    const wake = evidence.wake;
    const job = evidence.jobs.data.find(item => item.id === expected.jobId);
    if (!observed(evidence.origin, origin) ||
        evidence.origin.data.event !== 'issues' ||
        !text(expected.reusableWorkflow) || !text(expected.sharedWorkflow) ||
        !positive(expected.runnerId) || !text(expected.runnerLabel) ||
        !same(evidence.route, expected, issueKeys.concat(['reusableWorkflow'])) ||
        evidence.route.decision !== 'forwarded' ||
        !same(wake, expected, issueKeys.concat(executionKeys,
          ['sharedWorkflow', 'runnerLabel'])) ||
        evidence.run.data.path !== expected.sharedWorkflow ||
        job.runner_id !== expected.runnerId || !Array.isArray(job.labels) ||
        job.labels.length > 100 ||
        !job.labels.includes(expected.runnerLabel)) {
      return result('unverified', 'SHARED_WAKE_CORRELATION_REQUIRED');
    }
  } else {
    const action = evidence.action;
    const job = evidence.jobs.data.find(item => item.id === expected.jobId);
    if (!same(action, expected, executionKeys) || action.executed !== true ||
        !positive(action.stepNumber) || !Array.isArray(job.steps) ||
        job.steps.length > 1000 ||
        job.steps.filter(step => step?.number === action.stepNumber).length !== 1) {
      return result('unverified', 'ACTION_INVOCATION_REQUIRED');
    }
    const step = job.steps.find(item => item?.number === action.stepNumber);
    const core = evidence.core[0];
    if (step.status !== 'completed' || step.name !== action.stepName ||
        !text(action.actionRef) || !text(expected.actionRef) ||
        action.actionRef !== expected.actionRef ||
        !same(action.outputs, core, ['status', 'code']) ||
        action.outputs?.['receipt-hash'] !== core.receiptHash ||
        (expected.status === 'completed' && step.conclusion !== 'success') ||
        (expected.status === 'denied' && step.conclusion !== 'failure')) {
      return result('unverified', 'ACTION_OUTPUT_CORRELATION_REQUIRED');
    }
    if (expected.stage === 'not-a-stage' &&
        (expected.status !== 'denied' || expected.code !== 'INVALID_STAGE_REQUEST')) {
      return result('unverified', 'ACTION_DENIAL_CONTRACT_REQUIRED');
    }
  }
  // Pending is an observation, never a passing completion or negative assertion.
  return expected.status === 'pending' ? result('unverified', 'CORE_PENDING') :
    result('passed', mode === 'fixture' ? 'FIXTURE_CONTRACT_CONFIRMED' :
      expected.status === 'denied' ? 'EXPECTED_DENIAL_OBSERVED' : 'CORE_COMPLETED');
}

export function correlateNoAssignee(expected, evidence, mode = 'live') {
  const result = (state, code) => outcome('shared-issue', mode, state, code);
  if (!['live', 'fixture'].includes(mode) || !expected ||
      !/^[\w.-]+\/[\w.-]+$/.test(expected.repository ?? '') ||
      !positive(expected.issue) || !positive(expected.originRunId) ||
      !positive(expected.originAttempt) || !text(expected.reusableWorkflow) ||
      !observed(evidence?.issue, { kind: 'issue',
        repository: expected.repository, number: expected.issue }) ||
      !observed(evidence?.origin, { kind: 'run', repository: expected.repository,
        runId: expected.originRunId, attempt: expected.originAttempt }) ||
      evidence.origin.data.event !== 'issues' ||
      !same(evidence.route, expected, issueKeys.concat(['reusableWorkflow'])) ||
      evidence.route.decision !== 'no-eligible-assignee' ||
      evidence.route.forwarded !== false || evidence.wake != null ||
      !Array.isArray(evidence.core) || evidence.core.length !== 0) {
    return result('unverified', 'ROUTE_DENIAL_EVIDENCE_REQUIRED');
  }
  return result('passed', mode === 'fixture' ? 'FIXTURE_CONTRACT_CONFIRMED' :
    'EXPECTED_ROUTE_DENIAL_OBSERVED');
}
