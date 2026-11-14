import { fixtureBudget } from './fixture-budget.mjs';
import { readDependencyAdmission, readDependencyPair }
  from './dependency-observations.mjs';

// Read-only effect reconciliation. This never invokes Core or repeats a dispatch.
// The protected owner retains the inventory until this and idle teardown succeed.
export async function reconcileDependencyExecution(inventory, caller, bounds = {}) {
  try {
    const budget = fixtureBudget(bounds);
    const call = action => budget.call(action);
    return await inventory.exclusive(async (state, save) => {
      const pending = state.dependencyExecution;
      if (pending?.state !== 'intent') return { state: 'passing' };
      const evidence = await call(signal =>
        caller.readDependencyEvidence(structuredClone(pending.binding), signal));
      const result = await readDependencyAdmission(pending.binding,
        evidence?.admission, caller, call);
      const pair = await readDependencyPair(pending.pair,
        target => call(signal => caller.observe(target, signal)),
        pending.binding.phase === 'after');
      if (!result || !pair || result.decision === 'eligible') {
        return { state: 'unverified', code: 'DEPENDENCY_EFFECT_UNKNOWN' };
      }
      state.dependencyExecution = { ...pending, state: 'observed', result };
      await save();
      return { state: 'passing' };
    });
  } catch { return { state: 'unverified', code: 'DEPENDENCY_EFFECT_UNKNOWN' }; }
}
