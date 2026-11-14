import { randomUUID } from 'node:crypto';
import { withDeliverySources } from './delivery-sources.mjs';
import { fixtureDefinition, generatedPath } from './fixture-definition.mjs';
import { fixtureBudget } from './fixture-budget.mjs';
import { observeLiveWake } from './wake-protected.mjs';
import { capabilityNames, validRequest, same, positive } from './delivery-contract.mjs';
import { validateDelivery } from './delivery-evidence.mjs';
import { verifyDeliveryNative } from './delivery-native.mjs';

/**
 * @param {import('./delivery-contract.mjs').DeliveryRequest} request
 * @param {import('./delivery-contract.mjs').DeliveryCaller} caller
 * @param {object} bounds
 * @returns {Promise<object>} Bounded public result; never raw receipts or errors.
 */
async function observeDelivery(request, caller, bounds = {}) {
  const mode = caller?.mode;
  const output = (state, code) => ({ state, code,
    mode: mode === 'fixture' ? 'fixture' : 'live', liveVerified: false });
  if (!validRequest(request)) return output('blocked', 'INVALID_REQUEST');
  for (const name of capabilityNames) {
    if (typeof caller?.[name] !== 'function') return {
      ...output('blocked', 'CAPABILITY_UNAVAILABLE'), capability: name,
    };
  }
  if (!['live', 'fixture'].includes(mode)) {
    return output('blocked', 'PROVENANCE_REQUIRED');
  }
  let lifecycle;
  let phase = 'FIXTURE_UNAVAILABLE';
  let outcome;
  try {
    const budget = fixtureBudget(bounds);
    const call = action => budget.call(action);
    const definition = fixtureDefinition('fresh-delivery', request.repository);
    const owned = await call(signal => caller.createFixture(definition, signal));
    if (!same(owned?.definition, definition, Object.keys(definition)) ||
        ['setup', 'mutateIssue', 'teardown'].some(name =>
          typeof owned?.lifecycle?.[name] !== 'function')) {
      return output('unverified', phase);
    }
    lifecycle = owned.lifecycle;
    const setup = await call(() => lifecycle.setup('issue'));
    const resources = setup?.resources;
    if (setup?.state !== 'passing' || resources?.length !== 1 ||
        resources[0].kind !== 'issue' || resources[0].state !== 'owned' ||
        !positive(resources[0].native?.number) || !positive(resources[0].native?.id)) {
      outcome = output('unverified', 'FRESH_ISSUE_UNAVAILABLE');
    } else {
      const binding = { requestId: randomUUID(), repository: request.repository,
        issue: resources[0].native.number,
        path: `${definition.generatedRoot}${request.path}`, content: request.content };
      if (!generatedPath(definition, binding.path)) throw new Error();
      const body = `Implement this controlled fixture request ${binding.requestId}.\n` +
        `Create only ${binding.path} with this exact content:\n` +
        JSON.stringify(binding.content);
      phase = 'ISSUE_MUTATION_UNCONFIRMED';
      const mutation = await call(() => lifecycle.mutateIssue('edit-issue-body', body,
        { repository: binding.repository, number: binding.issue }));
      if (mutation?.state !== 'passing') throw new Error();
      phase = 'TRIGGER_EFFECT_UNKNOWN';
      const wake = await call(signal => caller.trigger({ ...binding }, signal));
      if (!same(wake, binding, ['repository', 'issue']) ||
          wake.status !== 'completed') throw new Error();
      binding.wake = wake;
      phase = 'WAKE_UNAVAILABLE';
      const observed = await observeLiveWake({
        leg: 'shared-issue', expected: wake,
        observe: target => call(signal => caller.observe(target, signal)),
        readEvidence: signal => caller.readWakeEvidence({ ...binding }, signal),
        bounds });
      if (observed.state !== 'passed') throw new Error();
      phase = 'STAGES_UNAVAILABLE';
      const evidence = await call(signal =>
        caller.readDeliveryEvidence(structuredClone(binding), signal));
      const chain = validateDelivery(binding, evidence);
      outcome = output(chain.state, chain.code);
      if (chain.state === 'satisfied') {
        phase = 'NATIVE_DELIVERY_UNAVAILABLE';
        const native = await verifyDeliveryNative(binding, evidence,
          target => call(signal => caller.observe(target, signal)));
        if (native.state !== 'satisfied') {
          outcome = output(native.state, native.code);
        } else {
          phase = 'SOURCE_ASSERTION_UNAVAILABLE';
          const source = await call(signal => caller.assertSource({ ...binding,
            head: evidence.pull.head, mergeCommit: evidence.pull.mergeCommit }, signal));
          if (source?.state === 'contradicted') {
            outcome = output('failed', 'SOURCE_BEHAVIOR_FAILED');
          } else if (source?.state !== 'satisfied' ||
              !same(source, { ...binding, head: evidence.pull.head,
                mergeCommit: evidence.pull.mergeCommit },
              ['requestId', 'repository', 'issue', 'path', 'content', 'head',
                'mergeCommit'])) {
            throw new Error();
          } else outcome = { ...output('passed', mode === 'fixture'
            ? 'FIXTURE_CONTRACT_CONFIRMED' : 'LIVE_DELIVERY_OBSERVED'),
          liveVerified: mode === 'live' };
        }
      }
    }
  } catch { outcome = output('unverified', phase); }
  // No retry or reconciliation after an unknown external effect. The lifecycle
  // refuses unsafe teardown and retains its durable inventory for the caller.
  if (lifecycle) {
    try {
      const cleanup = await fixtureBudget(bounds).call(() => lifecycle.teardown());
      if (cleanup?.state !== 'passing') return { ...outcome, state: 'unverified',
        liveVerified: false, cleanup: 'unresolved' };
    } catch { return { ...outcome, state: 'unverified', liveVerified: false,
      cleanup: 'unresolved' }; }
  }
  return outcome;
}

/** Acquire official current mains once for a protected live execution. */
export async function runDelivery(request, caller, bounds = {}) {
  if (caller?.mode !== 'live' || !validRequest(request) ||
      capabilityNames.some(name => typeof caller?.[name] !== 'function')) {
    return observeDelivery(request, caller, bounds);
  }
  try {
    return await withDeliverySources(prepared => observeDelivery(request, {
      mode: caller.mode,
      ...Object.fromEntries(capabilityNames.map(name => [name,
        (...args) => caller[name](...args)])),
      trigger: (binding, signal) => caller.trigger({ ...binding,
        sources: prepared.sources, sourceRoot: prepared.root }, signal),
    }, bounds));
  } catch {
    return { state: 'unverified', code: 'SOURCE_PREPARATION_OR_CLEANUP_UNAVAILABLE',
      mode: 'live', liveVerified: false };
  }
}
