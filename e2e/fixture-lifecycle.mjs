import { randomUUID } from 'node:crypto';
import { issueMutation, mutationObserved } from './fixture-issue.mjs';
import { operations, setupPayload } from './fixture-definition.mjs';
import { fixtureBudget } from './fixture-budget.mjs';
import { FixtureError, fixtureErrorCode } from './fixture-errors.mjs';

const clone = value => structuredClone(value);
function identity(definition, record, native, actor, requireMarker = true) {
  if (!native || native.absent) return false;
  if (record.kind === 'branch') {
    return native.ref === `refs/heads/${definition.name}` &&
      /^[a-f0-9]{40}$/.test(native.object?.sha ?? '') &&
      native.url === `https://api.github.com/repos/${definition.repository}/` +
        `git/refs/heads/${definition.name}`;
  }
  const path = record.kind === 'issue' ? 'issues' : 'pulls';
  return Number.isSafeInteger(native.id) && native.id > 0 &&
    Number.isSafeInteger(native.number) && native.number > 0 &&
    native.user?.id === actor &&
    (!requireMarker || native.body?.includes(definition.marker)) &&
    native.url === `https://api.github.com/repos/${definition.repository}/` +
      `${path}/${native.number}` &&
    (record.kind !== 'issue' || !native.pull_request) &&
    (record.kind !== 'pull' || (native.head?.ref === definition.name &&
      native.head?.repo?.full_name === definition.repository));
}
function sameNative(record, native) {
  return record.kind === 'branch' ||
    (record.native.id === native.id && record.native.number === native.number);
}
function nativeIdentity(record, native) {
  return record.kind === 'branch' ? { ref: native.ref, sha: native.object.sha } :
    { id: native.id, number: native.number };
}
const unresolved = state => state.resources.some(record =>
  record.mutation || ['intent', 'unknown', 'cleanup-intent'].includes(record.state));

// context is an in-process protected-runner capability, never fixture input.
// authorize, idle and receipt must consult protected/native evidence. A plain
// marker, actor name, environment claim or caller-selected target is insufficient.
export function fixtureLifecycle({ inventory, provider, context, bounds = {} }) {
  if (typeof context?.authorize !== 'function' ||
      typeof context?.idle !== 'function') throw new Error('Protected context required');
  async function execute(action) {
    return inventory.exclusive(async (state, save) => {
      const budget = fixtureBudget(bounds);
      const definition = state.definition;
      const implementation = provider(budget, clone(definition));
      const api = Object.fromEntries(Object.entries(implementation).map(([key, fn]) =>
        [key, (...args) => budget.call(() => fn(...args))]));
      const call = action => budget.call(() => action());
      const authorize = async operation => {
        if (await call(() => context.authorize({
          repository: definition.repository, actor: state.actor,
          owner: definition.owner, operation,
        })) !== true) throw new FixtureError('FIXTURE_AUTHORIZATION_DENIED');
        if (await api.preflight() !== state.actor) {
          throw new FixtureError('FIXTURE_ACTOR_MISMATCH');
        }
      };
      const readOwned = async record => {
        const native = await api.read(clone(record));
        if (native?.absent === true) return native;
        if (!identity(definition, record, native, state.actor, false) ||
            !sameNative(record, native)) {
          throw new FixtureError('FIXTURE_IDENTITY_MISMATCH');
        }
        return native;
      };
      const tools = { state, save, budget, api, call, authorize, readOwned };
      try {
        await action(tools);
        state.lastResult = { state: unresolved(state) ? 'unverified' : 'passing',
          ...(unresolved(state) ? { reason: 'FIXTURE_EFFECT_UNKNOWN' } : {}) };
        await save();
        return { ...state.lastResult,
          inventory: inventory.path, resources: clone(state.resources) };
      } catch (error) {
        // Recovery state is the diagnostic. Provider errors may contain secrets.
        state.lastResult = { state: 'unverified', reason: fixtureErrorCode(error) };
        await save();
        return { ...state.lastResult,
          inventory: inventory.path, resources: clone(state.resources) };
      }
    });
  }
  return {
    setup(kind, input) {
      return execute(async ({ state, save, budget, api, authorize, readOwned }) => {
        budget.operation();
        if (unresolved(state)) throw new FixtureError('FIXTURE_RECONCILIATION_REQUIRED');
        if (!Object.hasOwn(operations, kind)) {
          throw new FixtureError('FIXTURE_UNSUPPORTED_RESOURCE');
        }
        if (state.resources.some(record => record.kind === kind)) {
          throw new FixtureError('FIXTURE_RESOURCE_ALREADY_INVENTORIED');
        }
        const payload = setupPayload(state.definition, kind, input);
        await authorize(operations[kind].setup);
        if (kind === 'pull') {
          const branch = state.resources.find(record => record.kind === 'branch');
          if (!branch || branch.state !== 'owned' ||
              (await readOwned(branch)).absent) {
            throw new FixtureError('FIXTURE_OWNED_HEAD_REQUIRED');
          }
        }
        const record = { kind, operation: randomUUID(), payload,
          cleanup: operations[kind].teardown, native: null, state: 'intent',
          disposition: 'recoverable' };
        await api.beforeCreate(clone(record));
        state.resources.push(record);
        await save();
        // A crash or timeout from here leaves an unresolved durable creation intent.
        try {
          const native = await api.create(clone(record));
          if (!identity(state.definition, record, native, state.actor) ||
              (kind === 'branch' && native.object.sha !== payload.sha)) {
            throw new FixtureError('FIXTURE_CREATION_IDENTITY_UNKNOWN');
          }
          record.native = nativeIdentity(record, native);
          await save();
          const current = await readOwned(record);
          if (current.absent) throw new FixtureError('FIXTURE_CREATION_NOT_OBSERVED');
          record.state = 'owned';
        } catch (error) {
          record.state = 'unknown';
          record.failure = fixtureErrorCode(error);
        }
        await save();
      });
    },
    mutateIssue(operation, input, target) {
      return execute(async ({ state, save, budget, api, authorize, readOwned }) => {
        budget.operation();
        if (unresolved(state)) throw new FixtureError('FIXTURE_RECONCILIATION_REQUIRED');
        const record = state.resources.find(item => item.kind === 'issue');
        if (!record || record.state !== 'owned') {
          throw new FixtureError('FIXTURE_OWNED_ISSUE_REQUIRED');
        }
        if (target && (target.repository !== state.definition.repository ||
            target.number !== record.native.number)) {
          throw new FixtureError('FIXTURE_IDENTITY_MISMATCH');
        }
        const mutation = issueMutation(state.definition, operation, input);
        await authorize(operation);
        const before = await readOwned(record);
        if (before.absent || before.state !== 'open') {
          throw new FixtureError('FIXTURE_OWNED_RESOURCE_MISSING');
        }
        record.mutation = { ...mutation, operation: randomUUID() };
        await save();
        // Persist before writing. Failure or crash forbids replay until read-back.
        await api.mutateIssue(clone(record));
        if (!mutationObserved(await readOwned(record), mutation)) {
          throw new FixtureError('FIXTURE_MUTATION_EFFECT_UNKNOWN');
        }
        delete record.mutation;
        await save();
      });
    },
    reconcile() {
      return execute(async ({ state, save, budget, api, call, authorize, readOwned }) => {
        for (const record of state.resources) {
          if (record.mutation) {
            budget.operation();
            await authorize('reconcile');
            if (await call(() => context.idle(clone(state))) !== true) {
              throw new FixtureError('FIXTURE_USAGE_UNRESOLVED');
            }
            if (!mutationObserved(await readOwned(record), record.mutation)) {
              throw new FixtureError('FIXTURE_MUTATION_EFFECT_UNKNOWN');
            }
            delete record.mutation;
            await save();
          }
          if (!['intent', 'unknown', 'cleanup-intent'].includes(record.state)) continue;
          budget.operation();
          await authorize('reconcile');
          if (!record.native) {
            // Discovery by marker cannot establish ownership. A protected native
            // receipt bound to this exact intent can recover a lost response.
            const receipt = await call(() => context.receipt?.(clone(record),
              clone(state.definition)));
            if (!receipt || receipt.operation !== record.operation ||
                !identity(state.definition, record, receipt.native, state.actor)) {
              throw new FixtureError('FIXTURE_NATIVE_RECEIPT_REQUIRED');
            }
            record.native = nativeIdentity(record, receipt.native);
            await save();
          }
          const native = await readOwned(record);
          if (record.state === 'cleanup-intent' && native.merged === true) {
            record.state = 'retained';
            record.disposition = 'merged-history';
          } else if (record.state === 'cleanup-intent' &&
              (native.absent || native.state === 'closed')) {
            record.state = 'cleaned';
            record.disposition = 'removed-from-active-work';
          }
          else {
            if (record.state === 'cleanup-intent') {
              throw new FixtureError('FIXTURE_CLEANUP_EFFECT_UNKNOWN');
            }
            if (native.absent) throw new FixtureError('FIXTURE_CREATION_NOT_OBSERVED');
            record.state = 'owned';
          }
          await save();
        }
      });
    },
    teardown() {
      return execute(async ({ state, save, budget, api, call, authorize, readOwned }) => {
        if (unresolved(state)) throw new FixtureError('FIXTURE_RECONCILIATION_REQUIRED');
        // Pulls precede branches, with Issues last; merged history is never rolled back.
        const ordered = ['pull', 'branch', 'issue'].flatMap(kind =>
          state.resources.filter(record => record.kind === kind));
        for (const record of ordered) {
          if (record.state !== 'owned') continue;
          budget.operation();
          await authorize(record.cleanup);
          const native = await readOwned(record);
          if (native.absent) throw new FixtureError('FIXTURE_OWNED_RESOURCE_MISSING');
          if (await call(() => context.idle(clone(state))) !== true) {
            throw new FixtureError('FIXTURE_USAGE_UNRESOLVED');
          }
          const merged = native.merged;
          if ((record.kind === 'pull' || record.kind === 'branch') &&
              typeof merged !== 'boolean') {
            throw new FixtureError('FIXTURE_MERGE_STATE_UNKNOWN');
          }
          if (merged === true && record.kind !== 'issue') {
            record.state = 'retained';
            record.disposition = 'merged-history';
            await save();
            continue;
          }
          if (native.state === 'closed' && record.kind !== 'branch') {
            record.state = 'cleaned';
            await save();
            continue;
          }
          if (record.kind !== 'branch' && native.state !== 'open') {
            throw new FixtureError('FIXTURE_NATIVE_STATE_INCOMPLETE');
          }
          if (record.kind === 'branch' && native.object.sha !== record.payload.sha) {
            throw new FixtureError('FIXTURE_CHANGED_BRANCH_RETAINED');
          }
          record.state = 'cleanup-intent';
          await save();
          await api.cleanup(clone(record));
          const after = await readOwned(record);
          if (!(record.kind === 'branch' ? after.absent : after.state === 'closed')) {
            throw new FixtureError('FIXTURE_CLEANUP_EFFECT_UNKNOWN');
          }
          record.state = 'cleaned';
          record.disposition = 'removed-from-active-work';
          await save();
        }
      });
    },
  };
}
