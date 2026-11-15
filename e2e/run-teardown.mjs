import { fixtureBudget } from './fixture-budget.mjs';
import { cleanupHost, cleanupFixtures, cleanupRepositories,
  requireTeardown as require } from './run-teardown-resources.mjs';

const clone = value => structuredClone(value);

// Only protected composition supplies this capability object. All observations
// must be fresh, independent native reads, including affirmative absence proofs.
export function protectedRunTeardown({ inventory, context, bounds = {} }) {
  const methods = ['authorize', 'exclude', 'execution', 'discover', 'observe',
    'mutate', 'baseline', 'repository', 'deleteRepository', 'receipt'];
  require(typeof inventory?.exclusive === 'function' &&
    methods.every(key => typeof context?.[key] === 'function'));
  return Object.freeze({
    teardown() {
      return inventory.exclusive(async (state, save, retainLock) => {
        const budget = fixtureBudget(bounds);
        const outstanding = new Set();
        const call = action => budget.call(signal => {
          const pending = Promise.resolve().then(() => action(signal));
          outstanding.add(pending);
          pending.then(() => outstanding.delete(pending),
            () => outstanding.delete(pending));
          return pending;
        });
        const record = state.teardown ??= { operations: [] };
        let phase = 'exclusion';
        const intent = async (key, operation, execute, observed) => {
          const previous = record.operations.find(item => item.key === key &&
            item.operation === operation);
          if (await observed()) {
            if (previous) {
              previous.disposition = 'verified';
              await save();
            }
            return;
          }
          // A prior write must first be independently reconciled. Never replay it.
          require(!previous && record.operations.length < 512);
          budget.operation();
          const pending = { key, operation, disposition: 'unresolved' };
          record.operations.push(pending);
          await save();
          await execute();
          require(await observed());
          pending.disposition = 'verified';
          await save();
        };
        try {
          const d = state.definition;
          require(await call(signal => context.authorize(clone(d), { signal })) === true);
          // Exclusion is durable and run-owned; it is deliberately never released
          // here. Producers must consult it before dispatch, even after a crash.
          await intent('run', 'exclude', () => call(signal =>
            context.exclude(clone(d), { signal })), async () =>
            (await call(signal => context.execution(clone(state), { signal })))
              ?.excluded === true);
          phase = 'execution';
          const execution = await call(signal => context.execution(clone(state),
            { signal }));
          if (execution?.settled !== true) {
            await intent('run', 'settle', () => call(signal =>
              context.mutate('settle', null, clone(state), { signal })), async () => {
              const e = await call(signal => context.execution(clone(state), { signal }));
              return e?.excluded === true && e.settled === true &&
                e.effects === 'reconciled';
            });
          }
          const settled = await call(signal => context.execution(clone(state),
            { signal }));
          require(settled?.excluded === true && settled.settled === true &&
            settled.effects === 'reconciled');
          const tools = { state, record, save, call, intent, context, bounds,
            inventory };
          phase = 'host';
          await cleanupHost(tools);
          phase = 'fixtures';
          await cleanupFixtures(tools);
          phase = 'repositories';
          await cleanupRepositories(tools);
          phase = 'credentials';
          // Always consult the original private session: inventory cannot prove
          // that issuance never happened or reconstruct a lost helper token.
          require(typeof context.credentials?.revoke === 'function');
          await intent('run', 'revoke', async () => {
            const result = await call(() => context.credentials.revoke());
            require(result?.status === 'revoked');
            record.revoked = true;
            await save();
          }, async () => {
            if (record.revoked === true) return true;
            if (!record.operations.some(o => o.operation === 'revoke') ||
                typeof context.credentials.capabilities !== 'function') return false;
            const metadata = await call(() => context.credentials.capabilities());
            if (metadata?.automation?.status !== 'revoked') return false;
            record.revoked = true;
            await save();
            return true;
          });
          phase = 'baseline';
          require(await call(signal => context.baseline(clone(state),
            { signal })) === true);
          record.complete = true;
          await save();
          return { state: 'complete', phase, operations: clone(record.operations),
            protectedExecution: 'unverified' };
        } catch {
          // Rejected calls also may hide a still-running native command. Before
          // relinquishing ownership, independently reconcile current execution.
          if (record.operations.length && !outstanding.size) {
            try {
              const e = await call(signal => context.execution(clone(state), { signal }));
              if (e?.excluded !== true || e.settled !== true ||
                  e.effects !== 'reconciled') retainLock();
            } catch { retainLock(); }
          }
          record.complete = false;
          await save();
          return { state: 'unresolved', phase, operations: clone(record.operations),
            reason: 'TEARDOWN_UNRESOLVED' };
        } finally {
          // A timed-out adapter might still execute. Keep exclusive ownership;
          // only protected recovery may retire the lock after proving termination.
          if (outstanding.size) retainLock();
        }
      });
    },
  });
}
