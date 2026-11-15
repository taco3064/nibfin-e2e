import { wakeFixture } from './scenarios/wake-fixtures.mjs';

const clone = value => structuredClone(value);
const key = target => JSON.stringify(Object.entries(target).sort());
const fixtureIdentity = wakeFixture().expected;
export const simulatedAccount = Object.freeze({ id: fixtureIdentity.actorId,
  login: 'simulated' });
const repositoryIds = [fixtureIdentity.repositoryId, fixtureIdentity.runRepositoryId];
const slotIds = Object.freeze([fixtureIdentity.runnerId, fixtureIdentity.runnerId + 1]);
const operations = new Set(['create', 'seed', 'install', 'fixture', 'prepare',
  'trigger', 'deliver', 'fault', 'restore', 'recover', 'repeat', 'remove',
  'observe', 'exclude', 'revoke']);

// This capability is composed by trusted local code, never selected by a request.
// Only IDs, operation names and finite diagnostic codes enter the retained trace.
export function simulatedProvider(definition, retained, controls = {}) {
  const state = retained ?? {
    repositories: new Map(), observations: new Map(), executions: new Map(),
    registrations: new Map(), targets: new Map(), localResources: new Map(),
    receipts: new Map(), phases: new Map(), pending: new Set(), trace: [],
    sourceOwner: null, excluded: false, revoked: false, active: 0,
    effects: 'reconciled',
  };
  const { repositories, observations, executions, registrations, targets,
    localResources, receipts, phases, pending, trace } = state;
  let phase = 'provision';
  let runId = null;
  const repositoryId = name => repositoryIds[definition.repositories.indexOf(name)];
  const sharedRegistrations = name => [...registrations.values()].filter(row =>
    row.repositoryId === repositoryId(name) && row.memberId === definition.account.id);
  const pendingKey = (operation, repository) =>
    JSON.stringify([runId, phase, operation, repository]);
  const record = (operation, repository, outcome, resource = null) => {
    trace.push({ sequence: trace.length + 1, owner: definition.owner,
      runId, phase, sourceOwner: state.sourceOwner, operation, repository,
      resource, outcome });
  };
  const reject = (code, operation, repository) => {
    record(operations.has(operation) ? operation : 'rejected',
      definition.repositories.includes(repository) ? repository : null, code);
    throw new Error(code);
  };
  const authorize = (operation, repository, actor = definition.account.id) => {
    if (!operations.has(operation) || actor !== definition.account.id) {
      reject('SIM_OPERATION_DENIED', operation, repository);
    }
    if (!definition.repositories.includes(repository)) {
      reject('SIM_RESOURCE_UNRELATED', operation, repository);
    }
    if ((state.excluded || state.revoked) && !['observe', 'remove', 'exclude', 'revoke']
      .includes(operation)) reject('SIM_RUN_EXCLUDED', operation, repository);
  };
  const perform = (operation, repository, action, actor) => {
    authorize(operation, repository, actor);
    const result = action();
    record(operation, repository, 'observed');
    if (['create', 'trigger', 'remove'].includes(operation) &&
        controls.dropReply?.(operation, repository) === true) {
      if (operation !== 'remove') pending.add(pendingKey(operation, repository));
      record(operation, repository, 'reply-lost');
      throw new Error('SIM_REPLY_LOST');
    }
    return result;
  };
  const repository = name => {
    authorize('observe', name);
    const row = repositories.get(name);
    if (!row || row.owner !== definition.owner) {
      reject('SIM_RESOURCE_UNKNOWN', 'observe', name);
    }
    return row;
  };
  const store = (target, data) => {
    repository(target.repository);
    observations.set(key(target), { complete: true, target: clone(target),
      data: clone(data) });
    record('effect', target.repository, 'observed', { kind: target.kind,
      number: target.number ?? null, runId: target.runId ?? null,
      sha: target.sha ?? null });
  };
  return {
    definition, repositories, executions, registrations, targets, localResources,
    phases, pending,
    snapshot: () => clone(state),
    resolve(operation, repository) { pending.delete(pendingKey(operation, repository)); },
    receipt(record) {
      const receipt = receipts.get(record.operation);
      if (!receipt || receipt.operation !== record.operation ||
          receipt.repository !== record.repository ||
          receipt.runId !== runId || receipt.sourceOwner !== state.sourceOwner ||
          receipt.owner !== definition.owner) return null;
      return clone(receipt);
    },
    repositoryEvidence(record) {
      authorize('observe', record.repository);
      const receipt = this.receipt(record);
      const native = repositories.get(record.repository)?.native;
      return { independent: true, complete: Boolean(receipt), access: 'verified',
        repository: record.repository, id: receipt?.native.id,
        accountId: definition.account.id, absent: !native, native: clone(native) };
    },
    bindSources(owner) {
      if (state.sourceOwner !== null && state.sourceOwner !== owner) {
        throw new Error('SIM_SOURCE_OWNER_CONFLICT');
      }
      state.sourceOwner = owner;
    },
    get excluded() { return state.excluded; },
    get revoked() { return state.revoked; },
    get settled() { return state.active === 0 && state.effects === 'reconciled'; },
    get effects() { return state.effects; },
    trace: () => clone(trace),
    scope(id, name) { runId = id; phase = name; },
    authorize, perform, repository, store, repositoryId, sharedRegistrations, slotIds,
    observe(target) {
      return perform('observe', target.repository, () => {
        repository(target.repository);
        const result = observations.get(key(target));
        if (!result) reject('SIM_RESOURCE_UNKNOWN', 'observe', target.repository);
        record('observe', target.repository, 'readback',
          String(target.number ?? target.runId ?? target.sha ?? target.kind));
        return clone(result);
      });
    },
    create(record) {
      return perform('create', record.repository, () => {
        if (repositories.has(record.repository)) {
          reject('SIM_RESOURCE_EXISTS', 'create', record.repository);
        }
        const native = { id: repositoryId(record.repository),
          full_name: record.repository,
          owner: { ...definition.account, type: 'User' },
          description: definition.marker, default_branch: 'main',
          archived: false, disabled: false, visibility: 'public', private: false };
        repositories.set(record.repository, { owner: definition.owner, native,
          seeded: false, installed: false, service: 'inactive' });
        receipts.set(record.operation, { operation: record.operation,
          repository: record.repository, native: clone(native), runId,
          sourceOwner: state.sourceOwner, owner: definition.owner });
        return clone(native);
      });
    },
    requirePublic(name) {
      const row = repository(name);
      if (row.native.visibility !== 'public' || row.native.private !== false) {
        reject('SIM_PUBLIC_REPOSITORY_REQUIRED', 'install', name);
      }
      return row;
    },
    exclude() { state.excluded = true; record('exclude', null, 'observed'); },
    revoke() { state.revoked = true; record('revoke', null, 'observed'); },
    begin() { state.active++; },
    end(known = true) {
      state.active--;
      if (!known) state.effects = 'unknown';
    },
    sourceResult(repository, issue, state) {
      if (!['satisfied', 'contradicted', 'unknown'].includes(state)) {
        throw new Error('SIM_SOURCE_RESULT_INVALID');
      }
      record('execute-javascript', repository, state, String(issue));
    },
    network() { reject('SIM_NETWORK_FORBIDDEN', 'network', null); },
    remove(name) {
      return perform('remove', name, () => {
        const row = repository(name);
        if (!state.excluded || pending.size || !this.settled ||
            row.owner !== definition.owner) {
          reject('SIM_REMOVAL_UNSAFE', 'remove', name);
        }
        repositories.delete(name);
        for (const [id, observation] of observations) {
          if (observation.target.repository === name) observations.delete(id);
        }
      });
    },
  };
}
