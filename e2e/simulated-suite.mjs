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
import { finishDelivery } from './delivery-observation.mjs';
import { assertConcurrency } from './concurrency-assertions.mjs';
import { verifyConcurrencyNative } from './concurrency-protected.mjs';

// Explicit offline entrypoint. Run requests retain the existing suite contract;
// they cannot select providers, executable modules, credentials or host effects.
export async function createSimulatedSuite() {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-simulated-suite-'));
  try {
    const definition = repositoryDefinition(simulatedAccount,
      'simulated/source');
    const provider = simulatedProvider(definition);
    const inventory = await fixtureInventory(join(root, 'inventory'), definition,
      definition.account.id, join(root, 'worker'));
    const prepared = await simulatedSources(join(root, 'sources'));
    provider.bindSources(prepared.ownershipId);
    let runId;
    let running = false;
    let disposed = false;
    const scope = phase => provider.scope(runId, phase);
    const contexts = simulatedContexts(provider, prepared, scope);
    const completed = new Map();
    const specification = (phase, fault = false) => ({
      request: { repository: definition.repositories[0],
        assignee: definition.account, ...(fault ? { case: 'failed-ci' } : {}) },
      async open(context) {
        scope(phase);
        await context.checkpoint(`simulated-${phase}-${context.intent}`);
        const pair = simulatedCaller(provider, definition.repositories[0]);
        const opened = fault ? simulatedFault(provider, pair) : pair;
        const caller = { ...opened.caller };
        const history = caller.readConcurrencyEvidence;
        caller.readConcurrencyEvidence = async binding => {
          const result = await history(binding);
          completed.set(context.intent, { pair: opened, history: result });
          return result;
        };
        return { caller, resources: definition.repositories };
      },
      async reconcile(context) {
        scope(phase);
        const record = completed.get(context.intent);
        // No lost-reply redispatch. SIM-02 owns restart recovery. Existing
        // completed work can be independently checked without reexecuting it.
        if (!record || !provider.settled || record.history.effects !== 'reconciled') {
          return { state: 'unresolved', code: 'SIM_RECONCILIATION_REQUIRED',
            resources: definition.repositories };
        }
        const history = record.history;
        const pair = { requestId: history.requestId, case: history.case,
          repository: history.repository, issues: history.issues };
        const call = action => action(context.signal);
        if (assertConcurrency(pair, history).state !== 'passed' ||
            !await verifyConcurrencyNative(pair, history, call, record.pair.caller) ||
            (fault && record.pair.legs[0]?.ledger.faultExecution?.state !==
              'completed')) {
          return { state: 'unresolved', code: 'SIM_RECONCILIATION_REQUIRED',
            resources: definition.repositories };
        }
        for (const leg of record.pair.legs) {
          const result = await finishDelivery({ ...leg.binding,
            wake: leg.wake.expected }, record.pair.caller, call);
          if (result.state !== 'passed') {
            return { state: 'unresolved', code: result.code,
              resources: definition.repositories };
          }
        }
        return { state: 'passed', code: 'SIM_RECONCILED',
          resources: definition.repositories };
      },
    });
    const producers = suiteProducers({ delivery: specification('delivery'),
      failure: specification('failure', true) });
    const suite = createSuite({ inventory, prepared, ...contexts, ...producers,
      provenance: 'controlled', binding: 'simulated/local',
      verifyOwnership: async owner => owner === prepared && !disposed });
    return {
      provider, inventory, prepared, root,
      trace: () => provider.trace(),
      async run(request) {
        if (disposed || running) throw new Error('SIM_SUITE_UNAVAILABLE');
        running = true;
        runId = request?.runId;
        try { return await suite.run(request); }
        finally { running = false; }
      },
      async dispose() {
        if (running || !provider.settled ||
            [...provider.repositories.values()].some(row =>
              row.owner === definition.owner) || definition.repositories.some(name =>
              provider.sharedRegistrations(name).length) ||
            provider.localResources.size) {
          throw new Error('SIM_DISPOSAL_UNSAFE');
        }
        await rm(root, { recursive: true, force: true });
        prepared.disposed = true;
        disposed = true;
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
