/**
 * Protected caller contract. These callbacks never enter an ordinary worker.
 * @typedef {{repository: string, path: string, content: string}} DeliveryRequest
 * @typedef {{runRepository: string, runId: number, attempt: number,
 * jobId: number}} Admission
 * @typedef {{id: string, sessionId: string}} Execution
 * @typedef {{stage: string, outcome: string, requestId: string,
 * repository: string, issue: number, admission: Admission,
 * execution: Execution, shape: string, candidate?: string, head?: string,
 * pull?: number, agentExecuted?: boolean, runnerExecuted?: boolean,
 * hooks?: HookObservation[]}} StageObservation
 * @typedef {{definition: object, lifecycle: object}} OwnedFixture
 * @typedef {object} DeliveryCaller
 * @property {'live'|'fixture'} mode Explicit provenance, never inferred from success.
 * @property {function(object, AbortSignal): Promise<OwnedFixture>} createFixture
 * Creates a new durable inventory and lifecycle using fixture-lifecycle.mjs.
 * @property {function(object, AbortSignal): Promise<object>} trigger
 * Authenticated trigger returns the exact expected wake identity, not receipts.
 * @property {function(object, AbortSignal): Promise<object>} readWakeEvidence
 * @property {function(DeliveryBinding, AbortSignal):
 * Promise<DeliveryEvidence>} readDeliveryEvidence
 * Read-only extraction of Core stage receipts and referenced Candidate obligations.
 * @property {function(object, AbortSignal): Promise<object>} observe
 * Existing bounded GitHub observer, returning complete native observations.
 * @property {function(DeliveryBinding, AbortSignal):
 * Promise<SourceObservation>} assertSource
 * Read resulting delivered source and execute the maintained behavior assertion.
 * Returns a separately asserted source observation bound to the merge commit.
 */
export const stages = Object.freeze(['shape', 'validate-shape', 'publish-shape',
  'deliver', 'pre-accept', 'accept', 'post-accept', 'commit-pr',
  'review-pr', 'merge', 'close']);
export const capabilityNames = Object.freeze(['createFixture', 'trigger',
  'readWakeEvidence', 'readDeliveryEvidence', 'observe', 'assertSource']);
export const positive = value => Number.isSafeInteger(value) && value > 0;
export const identifier = value => typeof value === 'string' &&
  /^[\w.:-]{1,200}$/.test(value);
export const same = (actual, expected, keys) => !!actual &&
  keys.every(key => actual[key] === expected[key]);
export function validRequest(request) {
  return request && /^[\w.-]+\/[\w.-]+$/.test(request.repository ?? '') &&
    typeof request.path === 'string' && request.path.length <= 200 &&
    request.path.split('/').every(part => /^[\w.-]+$/.test(part) &&
      part !== '.' && part !== '..') &&
    typeof request.content === 'string' && request.content.length > 0 &&
    request.content.length <= 10000 && !request.content.includes('\0');
}
export function validAdmission(value) {
  return value && /^[\w.-]+\/[\w.-]+$/.test(value.runRepository ?? '') &&
    ['runId', 'attempt', 'jobId'].every(key => positive(value[key]));
}

/**
 * @typedef {{requestId: string, repository: string, issue: number}} IssueBinding
 * @typedef {IssueBinding & {path: string, content: string,
 * wake: Admission}} DeliveryBinding
 * @typedef {{path: string, event: 'pre-commit'|'prepare-commit-msg'|'commit-msg'}} Hook
 * @typedef {Hook & {executed: boolean, outcome: string}} HookObservation
 * @typedef {IssueBinding & {content: string, id: string, shape: string,
 * substantive: boolean, artifacts: object[],
 * paths: string[], hooks: Hook[]}} CandidateObservation
 * @typedef {{number: number, head: string, mergeCommit: string,
 * checkIds: number[]}} PullObservation
 * @typedef {{admissions: (Admission & IssueBinding)[],
 * stages: StageObservation[], candidate: CandidateObservation,
 * pull: PullObservation}} DeliveryEvidence
 * @typedef {DeliveryBinding & {state: string, head: string,
 * mergeCommit: string}} SourceObservation
 * @typedef {{state: 'passed'|'failed'|'blocked'|'unverified', code: string,
 * mode: 'live'|'fixture', liveVerified: boolean, capability?: string,
 * cleanup?: 'unresolved', sourceCleanup?: 'deferred'|'unresolved'}} DeliveryResult
 */
