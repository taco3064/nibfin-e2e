import { matches } from './github-resources.mjs';
import { assertObservation, confirmed } from './github-assertions.mjs';
import { same } from './delivery-contract.mjs';

export async function verifyDeliveryNative(binding, evidence, observe) {
  const unavailable = { state: 'unverified', code: 'NATIVE_DELIVERY_UNAVAILABLE' };
  const failed = { state: 'failed', code: 'NATIVE_EXECUTION_FAILED' };
  async function read(target) {
    const value = await observe(target);
    if (value?.complete !== true ||
        !same(value.target, target, Object.keys(target))) return null;
    const items = Array.isArray(value.data) ? value.data : [value.data];
    if (items.length > 1000 || items.some(item => !matches(item, target)) ||
        new Set(items.map(item => item.id)).size !== items.length) return null;
    return value;
  }
  for (const admission of evidence.admissions) {
    const { runRepository: repository, runId, attempt, jobId } = admission;
    const run = await read({ kind: 'run', repository, runId, attempt });
    const jobs = await read({ kind: 'jobs', repository, runId, attempt });
    const runResult = assertObservation(run, { conclusion: 'success' });
    const jobResult = assertObservation(jobs, { conclusion: 'success', ids: [jobId] });
    if (runResult.state === 'contradicted' || jobResult.state === 'contradicted') {
      return failed;
    }
    if (!confirmed(runResult) ||
        !confirmed(jobResult)) {
      return unavailable;
    }
  }
  const { repository, issue } = binding;
  const { number, head, mergeCommit, checkIds } = evidence.pull;
  const pull = await read({ kind: 'pull', repository, number });
  const checks = await read({ kind: 'checks', repository, sha: head });
  const closed = await read({ kind: 'issue', repository, number: issue });
  const ci = assertObservation(checks, { conclusion: 'success', ids: checkIds });
  const applicable = checks?.data?.filter(item => checkIds.includes(item.id));
  if (ci.state === 'contradicted' && applicable?.some(item =>
      ['failure', 'timed_out', 'cancelled', 'action_required']
        .includes(item.conclusion))) {
    return { state: 'failed', code: 'NATIVE_CI_FAILED' };
  }
  const complete = confirmed(assertObservation(pull, { merged: true })) &&
    pull.data.head?.sha === head && pull.data.merge_commit_sha === mergeCommit &&
    confirmed(ci) &&
    confirmed(assertObservation(closed, { closed: true })) &&
    closed.data.labels?.some(label => label.name === 'delivered') === true;
  return complete
    ? { state: 'satisfied', code: 'NATIVE_DELIVERY_OBSERVED' } : unavailable;
}
