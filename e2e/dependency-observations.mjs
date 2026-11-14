import { matches } from './github-resources.mjs';
import { observed, nativeExecution } from './wake-correlation.mjs';
import { positive, same, identifier, validAdmission } from './delivery-contract.mjs';

export const continuationKeys = Object.freeze([
  'runRepository', 'runId', 'attempt', 'jobId', 'invocation',
]);
const issueTarget = (repository, number) => ({ kind: 'issue', repository, number });
function collection(value, target) {
  return value?.complete === true && same(value.target, target, Object.keys(target)) &&
    Array.isArray(value.data) && value.data.length <= 2000 &&
    value.data.every(item => matches(item, target)) &&
    new Set(value.data.map(item => item.id)).size === value.data.length;
}

// Both directions are read from GitHub. No eligibility graph is computed here.
export async function readDependencyPair(binding, observe, completed = false) {
  const { repository, upstream, downstream } = binding;
  const result = {};
  for (const [name, target] of Object.entries({
    upstream: issueTarget(repository, upstream.number),
    downstream: issueTarget(repository, downstream.number),
    blockedBy: { kind: 'blocked_by', repository, number: downstream.number },
    blocking: { kind: 'blocking', repository, number: upstream.number },
  })) result[name] = await observe(target);
  for (const name of ['upstream', 'downstream']) {
    const expected = binding[name];
    if (!observed(result[name], issueTarget(repository, expected.number)) ||
        result[name].data.id !== expected.id) return false;
  }
  const up = result.upstream.data;
  if (result.downstream.data.state !== 'open' ||
      !Array.isArray(up.labels) || up.labels.some(label =>
        typeof label?.name !== 'string') ||
      up.state !== (completed ? 'closed' : 'open') ||
      up.labels.some(label => label.name === 'delivered') !== completed) return false;
  for (const [name, kind, source, peer] of [
    ['blockedBy', 'blocked_by', downstream, upstream],
    ['blocking', 'blocking', upstream, downstream],
  ]) {
    const value = result[name];
    if (!collection(value, { kind, repository, number: source.number }) ||
        !value.data.some(item => item.id === peer.id && item.number === peer.number)) {
      return false;
    }
  }
  return true;
}

/** Evidence is extracted independently from protected Core records. The admission
 * response alone never proves blocking, eligibility, authorization or dispatch. */
export async function readDependencyAdmission(binding, expected, caller, call) {
  const keys = ['requestId', 'repository', 'upstreamIssue', 'issue', 'phase',
    'upstreamRequestId'];
  if (!same(expected, binding, keys) || !validAdmission(expected) ||
      !identifier(expected.invocation) || !identifier(expected.reason) ||
      !['blocked', 'eligible', 'ineligible', 'dispatched'].includes(expected.decision)) {
    return null;
  }
  const evidence = await call(signal =>
    caller.readDependencyEvidence(structuredClone(binding), signal));
  const record = evidence?.admission;
  if (!same(record, expected, keys.concat(['runRepository', 'runId', 'attempt',
    'jobId', 'invocation', 'reason', 'decision'])) || record.authorized !== true ||
      record.executed !== true) return null;
  const native = {};
  for (const [key, target] of Object.entries({
    run: { kind: 'run', repository: expected.runRepository,
      runId: expected.runId, attempt: expected.attempt },
    jobs: { kind: 'jobs', repository: expected.runRepository,
      runId: expected.runId, attempt: expected.attempt },
  })) native[key] = await call(signal => caller.observe(target, signal));
  if (!nativeExecution(native, expected, expected.decision !== 'dispatched')) return null;
  if (expected.decision === 'dispatched' &&
      !['workflow_dispatch', 'repository_dispatch'].includes(native.run.data.event)) {
    return null;
  }
  // A copied upstream execution is not a downstream invocation.
  const origin = binding.continuation;
  if (expected.decision === 'dispatched' && origin &&
      expected.runRepository === origin.runRepository &&
      expected.runId === origin.runId) return null;
  if (binding.phase === 'after') {
    if (!origin || !same(record.continuation, origin, continuationKeys) ||
        !positive(record.upstreamIssue) ||
        !['issues', 'workflow_dispatch', 'repository_dispatch'].includes(
          record.originEvent)) return null;
    const target = { kind: 'run', repository: origin.runRepository,
      runId: origin.runId, attempt: origin.attempt };
    const observation = await call(signal => caller.observe(target, signal));
    if (!observed(observation, target) ||
        observation.data.event !== record.originEvent) return null;
  }
  return { decision: record.decision, reason: record.reason };
}
