import { mkdir, open, realpath, rm, access }
  from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { repositoryDefinition } from './repository-definition.mjs';
import { simulatedAccount } from './simulated-provider.mjs';
import { simulatedSourceDefinition, simulatedSources } from './simulated-local.mjs';
import { encodeSimulation, decodeSimulation } from './simulated-codec.mjs';
import { saveSession, readSession, checkSessionTree }
  from './simulated-session-files.mjs';
import { suiteId, sameBinding, suiteReport, suitePhases } from './suite-result.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const corrupt = () => { throw new Error('SIM_SESSION_CORRUPT'); };
function validateManifest(value, runId) {
  if (value?.version !== 1 || !suiteId(value.runId) || value.runId !== runId) {
    throw new Error('SIM_SESSION_BINDING_CONFLICT');
  }
  if (!uuid.test(value.owner) || value.root !== `.nibfin-suite-${value.owner}` ||
      !/^simulated-[a-f0-9-]{36}$/.test(value.sourceOwner)) corrupt();
  const d = value.definition;
  const expected = { owner: value.owner, repository: 'simulated/source',
    account: simulatedAccount, marker: `nibfin-disposable:${value.owner}`,
    repositories: [1, 2].map(n => `simulated/nibfin-${value.owner}-${n}`) };
  if (!sameBinding(d, expected)) corrupt();
}

function validateProvider(state, sourceOwner) {
  const maps = ['repositories', 'observations', 'executions', 'registrations',
    'targets', 'localResources', 'receipts', 'phases'];
  if (!state || maps.some(key => !(state[key] instanceof Map)) ||
      !(state.pending instanceof Set) || !Array.isArray(state.trace) ||
      state.sourceOwner !== sourceOwner || !Number.isSafeInteger(state.active) ||
      state.active < 0 || !['reconciled', 'unknown'].includes(state.effects)) corrupt();
  // A lost process cannot prove termination of an outstanding local execution.
  if (state.active || state.effects !== 'reconciled' || state.localResources.size) {
    throw new Error('SIM_SESSION_EXECUTION_UNRESOLVED');
  }
}

function finalReport(manifest) {
  const result = manifest.final;
  if (result.runId !== manifest.runId || result.sourceOwner !== manifest.sourceOwner ||
      result.provenance !== 'controlled' || result.binding !== 'simulated/local') {
    corrupt();
  }
  const final = suiteReport({ ...result, resources: [] });
  if (final.cleanup !== 'complete') corrupt();
  return final;
}

function validRequest(request, runId, resume) {
  return request?.runId === runId && (request.resume === undefined ? false :
    request.resume) === resume &&
    [...suitePhases, 'complete'].includes(request.phase === undefined ?
      'complete' : request.phase);
}

// One lease spans restoration, all provider work and every atomic checkpoint.
// A crash retains this lease. No timestamp/PID guess can authorize lock removal.
export async function openSimulatedSession(options, compose) {
  const { stateDir, runId, resume = false } = options;
  if (!suiteId(runId) || typeof stateDir !== 'string' || !stateDir ||
      typeof resume !== 'boolean' || options.controls || options.delivery ||
      options.retained || options.checkpoint) throw new Error('SIM_SESSION_REQUEST');
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  const directory = await realpath(resolve(stateDir));
  const path = join(directory, 'simulated-session.json');
  const lockPath = join(directory, 'simulated-session.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('SIM_SESSION_OWNERSHIP_UNRESOLVED');
    throw error;
  }
  let base, manifest, released = false, root, running = false;
  let expectedResume = resume;
  let checkpointUnresolved = false;
  const release = async retain => {
    if (released) return;
    released = true;
    await lock.close();
    if (!retain) await rm(lockPath);
  };
  try {
    try { manifest = await readSession(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (manifest && !resume) throw new Error('SIM_SESSION_EXISTS');
    if (!manifest && resume) throw new Error('SIM_SESSION_NOT_FOUND');
    let prepared, state;
    if (!manifest) {
      const definition = repositoryDefinition(simulatedAccount, 'simulated/source');
      root = join(directory, `.nibfin-suite-${definition.owner}`);
      await mkdir(root, { mode: 0o700 });
      prepared = await simulatedSources(join(root, 'sources'));
      manifest = { version: 1, runId, owner: definition.owner,
        root: basename(root), definition, sourceOwner: prepared.ownershipId };
      await saveSession(join(root, 'ownership.json'), manifest);
      await saveSession(path, manifest);
    } else {
      validateManifest(manifest, runId);
      if (manifest.final) {
        return { async run(request) {
          if (!validRequest(request, runId, true)) {
            throw new Error('SIM_SESSION_BINDING_CONFLICT');
          }
          return finalReport(manifest);
        }, close: () => release(false) };
      }
      root = join(directory, manifest.root);
      await checkSessionTree(root);
      if (!sameBinding(await readSession(join(root, 'ownership.json')), manifest)) {
        corrupt();
      }
      prepared = simulatedSourceDefinition(join(root, 'sources'), manifest.sourceOwner);
      // Original source files must exist, with their fixed declarations intact.
      const pin = prepared.sources.core.output.pin;
      const action = await readSession(join(prepared.sources.action.checkout,
        'core-source.json'));
      const cli = await readSession(join(prepared.sources.cli.checkout,
        'internal/cli/producers.json'));
      if (!sameBinding(action, pin) || !sameBinding(cli,
        { core: pin, action: prepared.sources.action })) corrupt();
      const inventory = await readSession(join(root, 'inventory',
        `${manifest.owner}.json`));
      if (!sameBinding(inventory.definition, manifest.definition) ||
          inventory.actor !== simulatedAccount.id ||
          inventory.suite?.runId !== runId ||
          inventory.suite?.sourceOwner !== manifest.sourceOwner) corrupt();
      state = decodeSimulation(inventory.simulation);
      validateProvider(state, manifest.sourceOwner);
    }
    validateManifest(manifest, runId);
    base = await compose({ retained: { root, definition: manifest.definition,
      prepared, state }, checkpoint: encodeSimulation });
    // Initial durable provider identity exists before the first lifecycle action.
    if (!resume) await base.inventory.exclusive(async () => {});
    const close = async () => {
      if (running) throw new Error('SIM_SUITE_UNAVAILABLE');
      let retain = checkpointUnresolved || !base.provider.settled ||
        base.provider.localResources.size > 0;
      try { await access(`${base.inventory.path}.lock`); retain = true; }
      catch (error) { if (error.code !== 'ENOENT') retain = true; }
      await release(retain);
    };
    return { provider: base.provider, inventory: base.inventory,
      prepared: base.prepared, root: base.root, trace: base.trace, close,
      async restart(controls) {
        if (controls !== undefined) throw new Error('SIM_SESSION_REQUEST');
        if (released || running) throw new Error('SIM_SUITE_UNAVAILABLE');
        await close();
        return compose({ stateDir: directory, runId, resume: true });
      },
      async dispose() {
        if (!manifest.final || running) throw new Error('SIM_DISPOSAL_UNSAFE');
        await close();
      },
      async run(request) {
        if (released || running || !validRequest(request, runId, expectedResume)) {
          throw new Error('SIM_SESSION_BINDING_CONFLICT');
        }
        running = true;
        try {
          if (manifest.final) return finalReport(manifest);
          const result = await base.run(request);
          expectedResume = true;
          // Every saved inventory revision includes the provider graph from its
          // boundary. The retained lease fences any interrupted checkpoint.
          if (result.cleanup === 'complete') {
            await checkSessionTree(root);
            await base.dispose();
            manifest = { ...manifest, final: result };
            await saveSession(path, manifest);
          }
          return result;
        } catch (error) {
          // A failed save may leave an older graph behind a committed effect.
          // Keep the lease even when all in-memory producer calls have settled.
          checkpointUnresolved = true;
          throw error;
        } finally { running = false; }
      },
    };
  } catch (error) {
    // Creation failures may already have recovery state. Preserve it and the
    // lease rather than guessing that a partially written session is disposable.
    await release(Boolean(root));
    throw error;
  }
}
