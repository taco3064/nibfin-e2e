import { randomUUID } from 'node:crypto';
import { runDeliveryPairWithLifecycle } from './delivery-pair.mjs';
import { fixtureBudget } from './fixture-budget.mjs';
import { same, positive } from './delivery-contract.mjs';
import { verifyConcurrencyNative } from './concurrency-protected.mjs';
import { matches } from './github-resources.mjs';
import { faultCases, faultKeys, faultObservation, repeatedEffects, extendsHistory,
  compatibleHistory }
  from './fault-observations.mjs';

const capabilities = ['applyFault', 'readFaultEvidence', 'continueFault',
  'restoreFault'];
const executionKeys = ['runRepository', 'runId', 'attempt', 'jobId'];

// This is protected composition, never an ordinary worker's input surface.
// The A/B producer retains its source preparation, admission and delivery proofs.
export async function runFaultLifecycle(request, caller, bounds = {}) {
  const output = (state, code) => ({ state, code,
    mode: caller?.mode === 'fixture' ? 'fixture' : 'live', liveVerified: false,
    fault: request?.case });
  if (!faultCases.includes(request?.case)) return output('blocked', 'INVALID_CASE');
  for (const name of capabilities) if (typeof caller?.[name] !== 'function') {
    return { ...output('blocked', 'CAPABILITY_UNAVAILABLE'), capability: name };
  }
  const budget = fixtureBudget(bounds);
  const call = action => budget.call(action);
  const owned = new Map();
  let binding, last, faultResult, sourceRoot;
  let phase = 'FAULT_SETUP_UNVERIFIED';
  let settled = false;
  let restored = false;
  async function save(state, extra = {}) {
    const inventory = owned.get(binding.issue).inventory;
    await inventory.exclusive(async (ledger, persist) => {
      if (state === 'intent' && ledger.faultExecution) throw new Error();
      ledger.faultExecution = { state, binding, ...extra,
        ...(sourceRoot ? { sourceRoot } : {}) };
      await persist();
    });
  }
  async function read(when) {
    const evidence = await call(signal => caller.readFaultEvidence(
      { ...binding, phase: when }, signal));
    const assertion = faultObservation(binding, evidence, when);
    faultResult = assertion;
    if (assertion.state !== 'passed') throw new Error();
    if (!await verifyConcurrencyNative({ repository: binding.repository,
      issues: [binding.issue] }, evidence.history, call, caller)) throw new Error();
    if (when !== 'before') {
      const target = evidence.resumedJob;
      if (!evidence.history.writers.some(a => same(a, target, executionKeys))) {
        throw new Error();
      }
    }
    if (when === 'before' && request.case === 'cancelled-writer') {
      const a = evidence.execution;
      const target = { kind: 'jobs', repository: a.runRepository,
        runId: a.runId, attempt: a.attempt };
      const jobs = await call(signal => caller.observe(target, signal));
      if (jobs?.complete !== true ||
          !same(jobs.target, target, Object.keys(target)) ||
          !Array.isArray(jobs.data) ||
          !jobs.data.every(job => matches(job, target)) ||
          !jobs.data.some(job => job.id === a.jobId &&
          job.conclusion === 'cancelled')) throw new Error();
    }
    last = evidence;
    return evidence;
  }
  async function restore() {
    if (!settled || restored) return;
    phase = 'FAULT_RESTORATION_UNVERIFIED';
    await save('restore-intent', { evidence: last });
    const result = await call(signal => caller.restoreFault(binding, signal));
    if (!same(result, binding, faultKeys) || result.ownedOnly !== true ||
        result.nativeReadBack !== true || result.localSettled !== true ||
        result.state !== 'restored') throw new Error();
    restored = true;
    await save('restored', { evidence: last });
  }
  const wrapped = { ...caller,
    async readConcurrencyEvidence(pair, signal) {
      const history = await caller.readConcurrencyEvidence(pair, signal);
      if (binding && (!last ||
          !compatibleHistory(last.history, history, binding.issue))) return null;
      return history;
    },
    async createFixture(definition, signal) {
      const fixture = await caller.createFixture(definition, signal);
      const lifecycle = fixture.lifecycle;
      return { ...fixture, lifecycle: { ...lifecycle,
        async prepareDelivery(...args) {
          if (typeof fixture?.inventory?.exclusive !== 'function') throw new Error();
          return lifecycle.prepareDelivery(...args);
        },
        async setup(...args) {
          const result = await lifecycle.setup(...args);
          const issue = result?.resources?.[0]?.native?.number;
          if (positive(issue)) owned.set(issue, fixture);
          return result;
        },
        async teardown() {
          if (binding && !restored) throw new Error();
          if (binding) await save('completed', { evidence: last });
          return lifecycle.teardown();
        },
      } };
    },
  };
  async function lifecycle(bindings, sources) {
    sourceRoot = sources.sourceRoot;
    const delivery = bindings[0];
    if (!binding) {
      binding = { ...structuredClone(delivery), operationId: randomUUID(),
        case: request.case, memberId: request.assignee.id };
      // Raw sources and protected callbacks never enter the durable inventory.
      delete binding.sources;
      delete binding.sourceRoot;
      try {
        await save('intent');
        const applied = await call(abort => caller.applyFault(binding, abort));
        if (!same(applied, binding, faultKeys) || applied.state !== 'applied') {
          throw new Error();
        }
        phase = 'FAULT_OBSERVATION_UNVERIFIED';
        const before = await read('before');
        if (request.case === 'failed-ci' && !await failingHead(before)) {
          faultResult = { state: 'unverified', code: 'EXACT_HEAD_FAILURE_UNVERIFIED' };
          throw new Error();
        }
        await save('observed', { evidence: before });
        // Restoration is fault-specific; it cannot itself authorize continuation.
        settled = true;
        await restore();
        for (const when of ['recover', 'repeat']) {
          phase = 'CONTINUATION_EFFECT_UNKNOWN';
          await save(`${when}-intent`, { evidence: last });
          const continued = await call(abort => caller.continueFault(
            { ...binding, phase: when }, abort));
          const previous = last;
          const after = await read(when);
          if (!extendsHistory(previous, after) ||
              !previous.committedEffects.every(id =>
                after.committedEffects.includes(id))) {
            faultResult = { state: 'unverified', code: 'RECOVERY_HISTORY_INCOMPLETE' };
            throw new Error();
          }
          if (when === 'recover') {
            if (!same(continued?.wake, after.resumedJob, executionKeys)) {
              throw new Error();
            }
            if (request.case === 'cancelled-writer' &&
                same(after.resumedJob, binding.wake, executionKeys)) {
              throw new Error();
            }
            delivery.wake = continued.wake;
          }
          if ((when === 'repeat' || request.case === 'completed-attempt' ||
              request.case === 'duplicate-continuation') &&
              !repeatedEffects(previous, after)) {
            faultResult = { state: 'failed', code: 'DUPLICATE_COMMITTED_EFFECT' };
            throw new Error();
          }
          await save('observed', { evidence: after });
        }
      } catch {
        if (!faultResult || faultResult.state === 'passed') {
          faultResult = { state: 'unverified', code: phase };
        }
        // Incomplete continuation/read-back cannot permit fixture teardown.
        restored = false;
        throw new Error();
      }
    }
  }
  async function failingHead(evidence) {
    const pull = evidence.pull;
    if (!positive(pull?.number) || !/^[a-f0-9]{40}$/.test(pull.head ?? '') ||
        !Array.isArray(pull.checkIds) || !pull.checkIds.length ||
        !pull.checkIds.every(positive) ||
        new Set(pull.checkIds).size !== pull.checkIds.length) return false;
    const target = { kind: 'pull', repository: binding.repository, number: pull.number };
    const native = await call(signal => caller.observe(target, signal));
    if (native?.complete !== true || !same(native.target, target, Object.keys(target)) ||
        !matches(native.data, target) || native.data?.head?.sha !== pull.head ||
        native.data?.merged !== false) {
      return false;
    }
    const checks = { kind: 'checks', repository: binding.repository, sha: pull.head };
    const observed = await call(signal => caller.observe(checks, signal));
    return observed?.complete === true &&
      same(observed.target, checks, Object.keys(checks)) &&
      Array.isArray(observed.data) && observed.data.length > 0 &&
      observed.data.every(c => matches(c, checks) && c.head_sha === pull.head) &&
      observed.data.some(c => pull.checkIds.includes(c.id) &&
        c.status === 'completed' && c.conclusion === 'failure');
  }
  const result = await runDeliveryPairWithLifecycle(request, wrapped, bounds, lifecycle);
  if (!binding) return result;
  if (faultResult?.state !== 'passed') return { ...result,
    ...output(faultResult?.state ?? 'unverified', faultResult?.code ?? phase),
    ...(binding ? { cleanup: 'unresolved' } : {}) };
  return { ...result, ...(result.state === 'passed' ? {
    code: caller.mode === 'fixture' ? 'FIXTURE_FAULT_RECOVERY_CONFIRMED' :
      'LIVE_FAULT_RECOVERY_OBSERVED', resumedJob: last.resumedJob,
    reason: last.reason } : {}) };
}
