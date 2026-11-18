import { openSimulatedSession } from './simulated-session.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryDefinition } from './repository-definition.mjs';
import { fixtureInventory } from './fixture-inventory.mjs';
import { createSuite } from './suite-drivers.mjs';
import { suiteProducers } from './suite-producers.mjs';
import { simulatedProvider, simulatedAccount } from './simulated-provider.mjs';
import { simulatedSources } from './simulated-local.mjs';
import { simulatedContexts } from './simulated-contexts.mjs';
import { simulatedCaller } from './simulated-caller.mjs';
import { simulatedFault } from './simulated-fault.mjs';
import { reconcileSimulated } from './simulated-recovery.mjs';

// Explicit offline entrypoint. Run requests retain the existing suite contract;
// they cannot select providers, executable modules, credentials or host effects.
export async function createSimulatedSuite(options = {}) {
  if (options.stateDir !== undefined) {
    return openSimulatedSession(options, createSimulatedSuite);
  }
  const { controls = {}, retained, checkpoint } = options;
  let { delivery } = options;
  const root = retained?.root ?? await mkdtemp(join(tmpdir(), 'nibfin-simulated-suite-'));
  try {
    delivery ??= retained?.delivery;
    const definition = retained?.definition ?? repositoryDefinition(simulatedAccount,
      'simulated/source');
    const provider = simulatedProvider(definition, retained?.state, controls);
    const inventory = await fixtureInventory(join(root, 'inventory'), definition,
      definition.account.id, join(root, 'worker'), state => {
        if (checkpoint) state.simulation = checkpoint(provider.snapshot());
      });
    const prepared = retained?.prepared ?? await simulatedSources(join(root, 'sources'));
    provider.bindSources(prepared.ownershipId);
    let runId;
    let running = false;
    let disposed = false;
    let retired = false;
    const scope = phase => provider.scope(runId, phase);
    const contexts = simulatedContexts(provider, prepared, scope, delivery?.agent);
    const specification = (phase, fault = false) => ({
      bounds: delivery?.producerBounds,
      request: { repository: definition.repositories[0],
        assignee: definition.account, ...(fault ? { case: 'failed-ci' } : {}) },
      async open(context) {
        scope(phase);
        await context.checkpoint(`simulated-${phase}-${context.intent}`);
        const record = { runId: context.runId, intent: context.intent,
          sourceOwner: prepared.ownershipId, sources: structuredClone(context.sources),
          legs: [], history: null };
        provider.phases.set(context.intent, record);
        const pair = simulatedCaller(provider, definition.repositories[0],
          record.legs, delivery);
        const opened = fault ? simulatedFault(provider, pair) : pair;
        const caller = { ...opened.caller };
        const resources = [...definition.repositories];
        const trigger = caller.trigger;
        caller.trigger = async binding => {
          const resource = `${binding.repository}/issues/${binding.issue}`;
          if (!resources.includes(resource)) resources.push(resource);
          return trigger(binding);
        };
        const history = caller.readConcurrencyEvidence;
        caller.readConcurrencyEvidence = async binding => {
          const result = await history(binding);
          record.history = structuredClone(result);
          return result;
        };
        return { caller, resources };
      },
      async reconcile(context) {
        scope(phase);
        return reconcileSimulated(provider, context, fault, delivery);
      },
    });
    const producers = suiteProducers({ delivery: specification('delivery'),
      failure: specification('failure', true) });
    const suite = createSuite({ inventory, prepared, ...contexts, ...producers,
      bounds: delivery?.suiteBounds,
      provenance: 'controlled', binding: 'simulated/local',
      verifyOwnership: async owner => owner === prepared && !disposed });
    return {
      provider, inventory, prepared, root,
      trace: () => provider.trace(),
      async restart(nextControls = {}) {
        if (running || disposed) throw new Error('SIM_SUITE_UNAVAILABLE');
        const state = provider.snapshot();
        const next = await createSimulatedSuite({ controls: nextControls,
          retained: { root, definition, prepared, state, delivery } });
        disposed = true;
        retired = true;
        return next;
      },
      async run(request) {
        if (disposed || running) throw new Error('SIM_SUITE_UNAVAILABLE');
        running = true;
        runId = request?.runId;
        try { return await suite.run(request); }
        finally { running = false; }
      },
      async dispose() {
        if (retired) throw new Error('SIM_SUITE_UNAVAILABLE');
        if (running || provider.pending.size || !provider.settled ||
            [...provider.repositories.values()].some(row =>
              row.owner === definition.owner) || definition.repositories.some(name =>
              provider.sharedRegistrations(name).length) ||
            provider.localResources.size) {
          throw new Error('SIM_DISPOSAL_UNSAFE');
        }
        await delivery?.close();
        await rm(root, { recursive: true, force: true });
        prepared.disposed = true;
        disposed = true;
      },
    };
  } catch (error) {
    if (!retained) await rm(root, { recursive: true, force: true });
    throw error;
  }
}
