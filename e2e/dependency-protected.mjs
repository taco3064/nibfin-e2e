import { randomUUID } from 'node:crypto';
import { fixtureDefinition, defaultTarget } from './fixture-definition.mjs';
import { fixtureBudget } from './fixture-budget.mjs';
import { capabilityNames, same, positive, validRequest } from './delivery-contract.mjs';
import { observeDelivery } from './delivery-protected.mjs';
import { withDeliverySources } from './delivery-sources.mjs';
import { readDependencyPair, readDependencyAdmission, continuationKeys }
  from './dependency-observations.mjs';

const capabilities = [...capabilityNames, 'admitDependency', 'readDependencyEvidence'];
const validTarget = (request, caller) => validRequest(request) &&
  (caller?.mode !== 'live' || request.repository === defaultTarget);
const freshIssue = result => result?.state === 'passing' &&
  result.resources?.length === 1 && result.resources[0].kind === 'issue' &&
  result.resources[0].state === 'owned' &&
  ['id', 'number'].every(key => positive(result.resources[0].native?.[key]));

// Protected library only. createFixture must return its durable inventory as well
// as the existing lifecycle. Public scenario inputs never provide capabilities.
async function execute(request, caller, bounds, sources = {}) {
  const mode = caller?.mode === 'fixture' ? 'fixture' : 'live';
  const output = (state, code, extra = {}) => ({ state, code, mode,
    liveVerified: false, ...extra });
  if (!validTarget(request, caller)) return output('blocked', 'INVALID_REQUEST');
  for (const name of capabilities) {
    if (typeof caller?.[name] !== 'function') return output('blocked',
      'CAPABILITY_UNAVAILABLE', { capability: name });
  }
  if (!['live', 'fixture'].includes(caller.mode)) {
    return output('blocked', 'PROVENANCE_REQUIRED');
  }
  const budget = fixtureBudget(bounds);
  const call = action => budget.call(action);
  let downstream;
  let upstream;
  let pair;
  let continuation;
  let outcome;
  let phase = 'FRESH_DOWNSTREAM_UNAVAILABLE';
  const observe = target => call(signal => caller.observe(target, signal));
  const readPair = completed => readDependencyPair(pair, observe, completed);
  async function admission(when) {
    const binding = { requestId: randomUUID(), repository: request.repository,
      upstreamIssue: pair.upstream.number, issue: pair.downstream.number,
      upstreamRequestId: pair.upstreamRequestId, phase: when,
      ...(when === 'after' ? { continuation } : {}) };
    // Intent is durable before any invocation. Unknown effects are never replayed.
    await downstream.inventory.exclusive(async (state, save) => {
      if (state.dependencyExecution?.state === 'intent') throw new Error();
      state.dependencyExecution = { state: 'intent', binding, pair };
      await save();
    });
    const expected = await call(signal =>
      caller.admitDependency({ ...structuredClone(binding), ...sources }, signal));
    const result = await readDependencyAdmission(binding, expected, caller, call);
    if (!result || !await readPair(when === 'after')) throw new Error();
    // Eligible without an actual dispatch remains unresolved, never success.
    if (result.decision === 'eligible') return result;
    await downstream.inventory.exclusive(async (state, save) => {
      state.dependencyExecution = { state: 'observed', binding, result };
      await save();
    });
    return result;
  }
  try {
    const definition = fixtureDefinition('dependency-downstream', request.repository);
    downstream = await call(signal => caller.createFixture(definition, signal));
    if (!same(downstream?.definition, definition, Object.keys(definition)) ||
        typeof downstream?.inventory?.exclusive !== 'function' ||
        typeof downstream?.lifecycle?.addDependency !== 'function') throw new Error();
    const setup = await call(() => downstream.lifecycle.setup('issue'));
    if (!freshIssue(setup)) throw new Error();
    const downstreamIdentity = setup.resources[0].native;
    const body = 'Implement this controlled downstream request.\n' +
      `Create only ${definition.generatedRoot}${request.path} with content:\n` +
      JSON.stringify(request.content);
    const mutation = await call(() => downstream.lifecycle.mutateIssue(
      'edit-issue-body', body, { repository: request.repository,
        number: downstreamIdentity.number }));
    if (mutation?.state !== 'passing') throw new Error();
    const wrapped = { ...caller,
      async createFixture(definition, signal) {
        upstream = await caller.createFixture(definition, signal);
        if (typeof upstream?.inventory?.exclusive !== 'function') throw new Error();
        const lifecycle = upstream.lifecycle;
        return { ...upstream, lifecycle: { ...lifecycle,
          async setup(...args) {
            const result = await lifecycle.setup(...args);
            if (!freshIssue(result)) return result;
            pair = { repository: request.repository,
              upstream: result.resources[0].native, downstream: downstreamIdentity };
            if (pair.upstream.id === pair.downstream.id ||
                pair.upstream.number === pair.downstream.number) throw new Error();
            return result;
          },
        } };
      },
      async trigger(binding, signal) {
        pair.upstreamRequestId = binding.requestId;
        phase = 'DEPENDENCY_SETUP_UNCONFIRMED';
        const linked = await call(() =>
          downstream.lifecycle.addDependency(upstream.inventory));
        if (linked?.state !== 'passing' || !await readPair(false)) throw new Error();
        phase = 'BLOCKED_ADMISSION_UNVERIFIED';
        const blocked = await admission('before');
        if (blocked.decision !== 'blocked') throw new Error();
        phase = 'UPSTREAM_COMPLETION_UNVERIFIED';
        const wake = await caller.trigger({ ...binding, ...sources }, signal);
        continuation = Object.fromEntries(
          continuationKeys.map(key => [key, wake?.[key]]));
        return wake;
      },
    };
    const delivery = await observeDelivery(request, wrapped, bounds);
    if (delivery.state !== 'passed') {
      outcome = output(delivery.state === 'failed' ? 'failed' : 'unverified',
        phase, { upstream: delivery.code,
          ...(delivery.cleanup === 'unresolved' ? { cleanup: 'unresolved' } : {}) });
    } else {
      phase = 'COMPLETED_DEPENDENCY_READ_UNVERIFIED';
      if (!await readPair(true)) throw new Error();
      phase = 'DOWNSTREAM_DISPATCH_EFFECT_UNKNOWN';
      const result = await admission('after');
      if (result.decision === 'dispatched') outcome = output('passed',
        mode === 'fixture' ? 'FIXTURE_CONTRACT_CONFIRMED' : 'LIVE_DEPENDENCY_OBSERVED',
        { liveVerified: mode === 'live', downstream: result });
      else outcome = output('unverified', result.decision === 'eligible'
        ? 'ELIGIBLE_WITHOUT_DISPATCH' : 'DOWNSTREAM_NOT_ELIGIBLE',
      { downstream: result });
    }
  } catch { outcome = output('unverified', phase); }
  if (downstream?.lifecycle) {
    try {
      const cleanup = await fixtureBudget(bounds).call(() =>
        downstream.lifecycle.teardown());
      if (cleanup?.state !== 'passing') throw new Error();
    } catch { return { ...outcome, state: 'unverified', liveVerified: false,
      cleanup: 'unresolved' }; }
  }
  return outcome;
}

export async function runDependency(request, caller, bounds = {}) {
  if (caller?.mode !== 'live' || !validTarget(request, caller) ||
      capabilities.some(name => typeof caller?.[name] !== 'function')) {
    return execute(request, caller, bounds);
  }
  try {
    return await withDeliverySources(prepared => execute(request, caller, bounds,
      { sources: prepared.sources, sourceRoot: prepared.root }));
  } catch {
    return { state: 'unverified', code: 'SOURCE_PREPARATION_OR_CLEANUP_UNAVAILABLE',
      mode: 'live', liveVerified: false };
  }
}
