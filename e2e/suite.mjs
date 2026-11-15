import { randomUUID } from 'node:crypto';
import { fixtureBudget } from './fixture-budget.mjs';
import { suitePhases, suiteId, suiteSources, sameBinding, phaseObservation,
  suiteReport, unobservedPhases } from './suite-result.mjs';

const copy = value => structuredClone(value);
const upstream = { install: 'provision', delivery: 'install', failure: 'delivery' };
const locations = prepared => [prepared.root ?? null,
  ...['core', 'action', 'cli'].map(id => prepared.sources[id].checkout ?? null)];

// Protected in-process composition only. compose receives a scoped view of the
// existing inventory, so existing drivers never reacquire its filesystem lock.
// Drivers expose execute/reconcile; reconciliation must never blindly redispatch.
export function protectedSuite({ inventory, prepared, verifyOwnership, compose,
  provenance = 'controlled', binding, bounds = {} }) {
  if (typeof inventory?.exclusive !== 'function' ||
      typeof compose !== 'function' || typeof verifyOwnership !== 'function' ||
      !['controlled', 'native'].includes(provenance) || !suiteId(binding)) {
    throw new Error('SUITE_PROTECTED_COMPOSITION_REQUIRED');
  }
  return Object.freeze({
    async run({ runId, phase = 'complete', resume = false } = {}) {
      if (!suiteId(runId) || ![...suitePhases, 'complete'].includes(phase) ||
          typeof resume !== 'boolean') throw new Error('SUITE_INVALID_REQUEST');
      return inventory.exclusive(async (state, save, retainLock) => {
        const budget = fixtureBudget(bounds);
        const outstanding = new Set();
        let open = true;
        let leased = false;
        let retained = false;
        const call = action => budget.call(signal => {
          const pending = Promise.resolve().then(() => action(signal));
          outstanding.add(pending);
          pending.then(() => outstanding.delete(pending),
            () => outstanding.delete(pending));
          return pending;
        });
        let record = state.suite;
        if (record && (!resume || record.runId !== runId ||
            record.binding !== binding || record.provenance !== provenance)) {
          throw new Error('SUITE_BINDING_CONFLICT');
        }
        const sourceUnavailable = async () => {
          const known = record ?? { runId, sources: [], binding, provenance,
            sourceOwner: null, resources: [], phases: unobservedPhases() };
          Object.assign(known.phases[phase === 'complete' ? 'provision' : phase],
            { state: 'unresolved', code: 'ORIGINAL_SOURCES_UNAVAILABLE' });
          if (record) await save();
          return { ...suiteReport(known), outcome: 'non-passing',
            reason: 'ORIGINAL_SOURCES_UNAVAILABLE' };
        };
        let sources;
        if (!suiteId(prepared?.ownershipId)) return sourceUnavailable();
        try { sources = suiteSources(prepared.sources); }
        catch { return sourceUnavailable(); }
        if (record) {
          if (record.sourceOwner !== prepared.ownershipId ||
              !sameBinding(record.locations, locations(prepared)) ||
              !sameBinding(record.sources, sources)) {
            throw new Error('SUITE_BINDING_CONFLICT');
          }
        } else {
          if (resume) throw new Error('SUITE_RUN_NOT_FOUND');
          record = { runId, sources, binding, provenance, resources: [],
            sourceOwner: prepared.ownershipId, locations: locations(prepared),
            phases: unobservedPhases() };
          state.suite = record;
          await save();
        }
        const scoped = { path: inventory.path,
          async exclusive(action) {
            if (!open || leased) throw new Error('SUITE_INVENTORY_LEASE_UNAVAILABLE');
            leased = true;
            try { return await action(state, async () => {
              if (!open) throw new Error('SUITE_LEASE_ENDED');
              await save();
            }, () => { retained = true; retainLock(); }); }
            finally { leased = false; }
          } };
        const context = () => ({ runId, prepared, sources: prepared.sources,
          binding, inventory: scoped });
        let drivers;
        let unavailable;
        const perform = async name => {
          const row = record.phases[name];
          let required = upstream[name];
          while (required && record.phases[required].state === 'passed') {
            required = upstream[required];
          }
          if (required) {
            if (!row.intent) Object.assign(row, { state: 'missing-input',
              code: `MISSING_${required.toUpperCase()}`, resources: [] });
            await save();
            return;
          }
          if (prepared.disposed !== false ||
              !sameBinding(record.sources, suiteSources(prepared.sources)) ||
              !sameBinding(record.locations, locations(prepared))) {
            row.state = 'unresolved';
            row.code = 'ORIGINAL_SOURCES_UNAVAILABLE';
            await save();
            return;
          }
          const driver = drivers?.[name];
          const recovering = Boolean(row.intent);
          const method = recovering ? driver?.reconcile : driver?.execute;
          if (typeof method !== 'function') {
            Object.assign(row, { state: 'unresolved',
              code: 'CAPABILITY_UNAVAILABLE' });
            await save();
            return;
          }
          try { budget.operation(); }
          catch {
            row.state = 'unresolved';
            row.code = 'SUITE_BOUND_EXHAUSTED';
            await save();
            return;
          }
          row.intent ??= randomUUID();
          row.state = 'unresolved';
          row.code = 'EFFECTS_PENDING';
          await save();
          // A checkpoint binds native execution identity before the adapter
          // performs any subsequent action. Only non-secret IDs are accepted.
          const checkpoint = async execution => {
            if (!open || !suiteId(execution) ||
                (row.execution && row.execution !== execution)) {
              throw new Error('SUITE_EXECUTION_CONFLICT');
            }
            row.execution = execution;
            await save();
          };
          try {
            const observation = await call(signal => method({ ...context(),
              phase: name, intent: row.intent, execution: row.execution,
              checkpoint, signal }));
            if (prepared.disposed !== false ||
                !sameBinding(record.sources, suiteSources(prepared.sources)) ||
                !sameBinding(record.locations, locations(prepared))) {
              throw new Error('SUITE_SOURCE_CHANGED');
            }
            if (retained) throw new Error('SUITE_DRIVER_RECOVERY_PENDING');
            const result = phaseObservation(observation);
            Object.assign(row, result);
            record.resources = [...new Set([...record.resources,
              ...result.resources])];
          } catch {
            row.state = 'unresolved';
            row.code = 'RECONCILIATION_REQUIRED';
          }
          await save();
        };
        try {
          if (prepared.disposed !== false || await call(signal =>
            verifyOwnership(prepared, copy(record.sources), { signal })) !== true ||
              !sameBinding(suiteSources(prepared.sources), record.sources)) {
            throw new Error('SUITE_ORIGINAL_SOURCES_UNAVAILABLE');
          }
          drivers = compose(context());
          if (phase !== 'complete' && phase !== 'cleanup') {
            const ancestors = [];
            let parent = upstream[phase];
            while (parent) {
              ancestors.unshift(parent);
              parent = upstream[parent];
            }
            for (const name of ancestors) {
              if (record.phases[name].state !== 'passed') break;
              await perform(name);
              if (outstanding.size || retained ||
                  record.phases[name].state !== 'passed') break;
            }
          }
          const selected = phase === 'complete' ? suitePhases.slice(0, -1) : [phase];
          for (const name of selected) {
            if (outstanding.size || retained) break;
            await perform(name);
            if (outstanding.size || retained ||
                record.phases[name].state !== 'passed') break;
          }
          // Unknown execution must remain owned. Teardown itself proves native
          // exclusion and settlement; never race it against an outstanding call.
          if (phase === 'complete') {
            if (!outstanding.size && !retained) await perform('cleanup');
            else {
              record.phases.cleanup.code = 'EXECUTION_STILL_PENDING';
              await save();
            }
          }
        } catch (error) {
          unavailable = error?.message === 'SUITE_ORIGINAL_SOURCES_UNAVAILABLE'
            ? 'ORIGINAL_SOURCES_UNAVAILABLE' : 'CAPABILITY_UNAVAILABLE';
          // No current-main preparation fallback, no raw diagnostic persistence.
          Object.assign(record.phases[phase === 'complete' ? 'provision' : phase],
            { state: 'unresolved', code: unavailable });
          await save();
        } finally {
          open = false;
          if (outstanding.size || leased) retainLock();
        }
        const result = suiteReport(record);
        return unavailable ? { ...result, outcome: 'non-passing',
          reason: unavailable } : result;
      });
    },
  });
}
