import { independentDeliveries } from './delivery-pair.mjs';
import { fixtureResults, observeFixture } from './delivery-fixtures.mjs';
import { simulatedCaller } from './simulated-caller.mjs';
import { finishDelivery } from './delivery-observation.mjs';
import { assertConcurrency } from './concurrency-assertions.mjs';
import { verifyConcurrencyNative } from './concurrency-protected.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Rebuild read capabilities from retained remote records, never a discarded
// caller or completed-operation closure. Committed effects are only observed;
// controlled unfinished-stage continuation is supplied as a separate capability.
export async function reconcileSimulated(provider, context, fault, delivery) {
  const repository = provider.definition.repositories[0];
  const record = provider.phases.get(context.intent);
  const fixtures = fixtureResults('unresolved',
    'SIM_TRIGGER_RECONCILIATION_REQUIRED');
  const unresolved = (code = 'SIM_TRIGGER_RECONCILIATION_REQUIRED',
    resource = repository) =>
    ({ state: 'unresolved', code, resources: [resource], fixtures });
  if (!record || record.intent !== context.intent ||
      record.runId !== context.runId ||
      record.sourceOwner !== context.prepared.ownershipId ||
      !same(record.sources, context.sources) || !provider.settled ||
      record.legs.length !== 2) return unresolved();
  const legs = record.legs;
  for (const leg of legs) {
    if (!leg.binding || !leg.wake || leg.binding.repository !== repository ||
        leg.binding.sourceRoot !== context.prepared.root ||
        !same(leg.binding.sources, context.sources) ||
        leg.binding.issue !== leg.issue || leg.binding.issueId !== leg.issueId ||
        leg.wake.expected.repository !== repository ||
        leg.wake.expected.issue !== leg.issue || !leg.wake.expected.runId ||
        legs.some(peer => peer !== leg && (peer.issue === leg.issue ||
          peer.binding?.pairRequestId !== leg.binding.pairRequestId))) {
      return unresolved('SIM_DISPATCH_BINDING_UNRESOLVED',
        `${repository}/issues/${leg.issue}`);
    }
  }
  const { caller, complete } = simulatedCaller(provider, repository, legs, delivery);
  // Only the controlled Claude coordinator can continue an unfinished stage.
  // Confirmed effects below retain the existing read-only reconciliation path.
  if (delivery) {
    try {
      for (const leg of legs) await complete(leg, true);
    } catch { return unresolved('CLAUDE_CONTINUATION_PENDING'); }
  }
  const pair = { requestId: legs[0].binding.pairRequestId, case: 'independent',
    repository, issues: legs.map(leg => leg.issue) };
  try {
    const history = record.history ?? await caller.readConcurrencyEvidence({ ...pair,
      deliveries: legs.map(leg => ({ ...leg.binding, wake: leg.wake.expected })) });
    const call = action => action(context.signal);
    if (assertConcurrency(pair, history).state !== 'passed' ||
        !await verifyConcurrencyNative(pair, history, call, caller) ||
        (fault && legs[0].ledger.faultExecution?.state !== 'completed')) {
      return unresolved('SIM_TRIGGER_OBSERVATION_UNAVAILABLE',
        `${repository}/issues/${legs[0].issue}`);
    }
    const deliveries = [];
    for (const [index, leg] of legs.entries()) {
      const row = fixtures[index];
      try {
        const binding = { ...leg.binding, wake: leg.wake.expected };
        const result = await finishDelivery(binding, caller, call, undefined,
          evidence => deliveries.push(evidence));
        Object.assign(row, observeFixture(result));
      } catch {
        row.state = 'unresolved';
        row.code = 'SIM_TRIGGER_OBSERVATION_UNAVAILABLE';
      }
    }
    if (fixtures.some(row => row.state !== 'passed')) {
      return unresolved('SIM_TRIGGER_OBSERVATION_UNAVAILABLE');
    }
    if (deliveries.length !== 2 || !independentDeliveries(deliveries, history)) {
      return unresolved('PAIRED_ASSOCIATION_UNAVAILABLE');
    }
  } catch {
    return unresolved('SIM_TRIGGER_OBSERVATION_UNAVAILABLE',
      `${repository}/issues/${legs[0].issue}`);
  }
  provider.resolve('trigger', repository);
  return { state: 'passed', code: 'SIM_RECONCILED',
    resources: provider.definition.repositories, fixtures };
}
