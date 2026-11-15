import { randomUUID } from 'node:crypto';
import { fixtureBudget } from './fixture-budget.mjs';
import { repositoryIdentity, repositoryNative } from './repository-definition.mjs';

const clone = value => structuredClone(value);
const fail = () => { throw new Error('Repository provisioning unresolved'); };

// Protected composition supplies authorization and native intent receipts.
// Persist and reuse the definition, including its exact pair, across resumption.
export function repositoryLifecycle({ inventory, provider, context, bounds = {} }) {
  if (typeof context?.authorize !== 'function' ||
      typeof context?.idle !== 'function') {
    throw new Error('Protected disposable account authorization required');
  }
  return {
    provision() {
      return inventory.exclusive(async (state, save) => {
        const budget = fixtureBudget(bounds);
        const definition = state.definition;
        const api = provider(budget, clone(definition));
        const call = action => budget.call(action);
        let ready = false;
        try {
          const account = definition.account;
          const names = definition.repositories;
          if (!account || state.actor !== account.id || !Array.isArray(names) ||
              names.length !== 2 || new Set(names).size !== 2 ||
              !names.every((name, index) => name === `${account.login}/` +
                `nibfin-${definition.owner}-${index + 1}`) ||
              names.includes(definition.repository) ||
              definition.marker !== `nibfin-disposable:${definition.owner}` ||
              !/^[a-f0-9-]{36}$/.test(definition.owner)) fail();
          const authorize = async operation => {
            if (await call(() => context.authorize({ operation,
              account: clone(account), actor: state.actor, owner: definition.owner,
              repositories: [...names] })) !== true) fail();
            if (await call(() => api.preflight()) !== account.id) fail();
          };
          await authorize('provision-disposable-repositories');
          if (!state.repositories) {
            state.repositories = names.map(repository => ({ repository,
              marker: definition.marker, account: clone(account),
              operation: randomUUID(), creation: 'intended', seed: 'intended',
              native: null }));
            await save();
          }
          const records = state.repositories;
          if (records.length !== 2 || records.some((r, i) =>
            r.repository !== names[i] || r.marker !== definition.marker ||
            r.account.id !== account.id || r.account.login !== account.login)) fail();
          for (const record of records) {
            budget.operation();
            await authorize('create-disposable-repository');
            if (record.creation === 'unresolved' || record.seed === 'unresolved') {
              if (await call(() => context.idle(clone(state))) !== true) fail();
            }
            if (record.creation === 'intended') {
              if (await call(() => api.observe(clone(record))) !== null) fail();
              record.creation = 'unresolved';
              await save();
              const native = await call(() => api.createRepository(clone(record),
                clone(definition)));
              if (!repositoryIdentity(definition, record, native)) fail();
              record.native = repositoryNative(native);
              await save();
            }
            if (!record.native) {
              const receipt = await call(() => context.receipt?.(clone(record),
                clone(definition)));
              if (receipt?.operation !== record.operation ||
                  !repositoryIdentity(definition, record, receipt.native)) fail();
              record.native = repositoryNative(receipt.native);
              await save();
            }
            const current = await call(() => api.observe(clone(record)));
            if (!repositoryIdentity(definition, record, current)) fail();
            if (records.some(peer => peer !== record &&
                peer.native?.id === current.id)) fail();
            record.creation = 'settled';
            await save();
            budget.operation();
            await authorize('seed-disposable-repository');
            if (record.seed === 'intended') {
              record.seed = 'unresolved';
              await save();
              await call(() => api.seedRepository(clone(record)));
            }
            if (await call(() => api.seedObserved(clone(record))) !== true) fail();
            // Verify identity again before exposing readiness.
            if (!repositoryIdentity(definition, record,
              await call(() => api.observe(clone(record))))) fail();
            record.seed = 'settled';
            await save();
          }
          ready = true;
        } catch {
          // Never persist raw provider diagnostics or credential bytes.
        }
        return { state: ready ? 'ready' : 'unresolved', inventory: inventory.path,
          repositories: clone(state.repositories ?? []),
          ...(ready ? {} : { reason: 'REPOSITORY_PROVISIONING_UNRESOLVED' }) };
      });
    },
  };
}
