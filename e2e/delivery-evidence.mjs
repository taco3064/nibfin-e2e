import { stages, same, identifier, validAdmission, positive }
  from './delivery-contract.mjs';

const admissionKeys = ['runRepository', 'runId', 'attempt', 'jobId'];
const bindingKeys = ['requestId', 'repository', 'issue'];
const result = (state, code) => ({ state, code });
const unavailable = code => result('unverified', code);

// Normalized observations are supplied by a protected reader, never authenticated
// by this validator. The reader must resolve referenced objects independently.
export function validateDelivery(binding, evidence) {
  if (!evidence || !Array.isArray(evidence.stages) ||
      evidence.stages.length !== stages.length ||
      !Array.isArray(evidence.admissions) || evidence.admissions.length === 0 ||
      evidence.admissions.length > 100) return unavailable('STAGES_UNAVAILABLE');
  const admissions = evidence.admissions;
  if (admissions.some(item => !validAdmission(item) ||
      !same(item, binding, bindingKeys)) ||
      new Set(admissions.map(item => JSON.stringify(admissionKeys.map(key =>
        item[key])))).size !== admissions.length ||
      !admissions.some(item => same(item, binding.wake, admissionKeys))) {
    return unavailable('ADMISSION_MISMATCH');
  }
  const records = evidence.stages;
  const executions = new Set();
  const sessions = new Set();
  for (const [index, stage] of stages.entries()) {
    const record = records[index];
    if (record?.stage !== stage || !same(record, binding, bindingKeys) ||
        !admissions.some(item => same(record.admission, item, admissionKeys)) ||
        !identifier(record.execution?.id) ||
        !identifier(record.execution?.sessionId) ||
        executions.has(record.execution.id) || sessions.has(record.execution.sessionId)) {
      return unavailable('STAGE_ASSOCIATION_MISMATCH');
    }
    executions.add(record.execution.id);
    sessions.add(record.execution.sessionId);
    if (record.outcome !== 'success') return record.outcome === 'failure'
      ? result('failed', 'STAGE_FAILED') : unavailable('STAGE_INCOMPLETE');
    if (['shape', 'validate-shape', 'deliver', 'accept', 'review-pr'].includes(stage) &&
        (record.agentExecuted !== true || record.runnerExecuted !== true)) {
      return unavailable('AGENT_EXECUTION_UNAVAILABLE');
    }
  }
  const shape = records[0].shape;
  if (!identifier(shape) || records.some(record =>
      record.shape !== shape)) return unavailable('SHAPE_ASSOCIATION_MISMATCH');
  const candidate = evidence.candidate;
  if (candidate?.shape !== shape || !identifier(candidate?.id) ||
      !same(candidate, binding, bindingKeys) ||
      !Array.isArray(candidate.paths) || candidate.paths.length !== 1 ||
      candidate.paths[0] !== binding.path || candidate.content !== binding.content ||
      candidate.substantive !== true || !Array.isArray(candidate.hooks) ||
      candidate.hooks.length > 100) return unavailable('CANDIDATE_UNAVAILABLE');
  if (!Array.isArray(candidate.artifacts) || candidate.artifacts.length !== 0) {
    return unavailable('ARTIFACT_OBLIGATION_UNSUPPORTED');
  }
  if (records.slice(3).some(record => record.candidate !== candidate.id)) {
    return unavailable('CANDIDATE_MISMATCH');
  }
  const events = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];
  if (candidate.hooks.some(hook => !events.includes(hook?.event) ||
      typeof hook.path !== 'string' || !hook.path || hook.path.length > 200)) {
    return unavailable('HOOK_OBLIGATION_UNSUPPORTED');
  }
  for (const [stage, pre] of [['pre-accept', true], ['post-accept', false]]) {
    const phase = records.find(record => record.stage === stage);
    const expected = candidate.hooks.filter(hook =>
      (hook.event === 'pre-commit') === pre);
    if (!Array.isArray(phase.hooks) || phase.hooks.length !== expected.length ||
        expected.some((hook, index) => !same(phase.hooks[index], hook,
          ['path', 'event']) || phase.hooks[index].executed !== true ||
          phase.hooks[index].outcome !== 'success')) {
      return unavailable('HOOK_EXECUTION_UNAVAILABLE');
    }
  }
  const pull = evidence.pull;
  if (!pull || !positive(pull.number) || !/^[a-f0-9]{40}$/.test(pull.head ?? '') ||
      !/^[a-f0-9]{40}$/.test(pull.mergeCommit ?? '') ||
      !Array.isArray(pull.checkIds) || pull.checkIds.length === 0 ||
      pull.checkIds.length > 1000 || !pull.checkIds.every(positive) ||
      new Set(pull.checkIds).size !== pull.checkIds.length ||
      records.slice(7).some(record => record.head !== pull.head ||
        record.pull !== pull.number)) return unavailable('PR_ASSOCIATION_MISMATCH');
  return result('satisfied', 'DELIVERY_CHAIN_OBSERVED');
}
