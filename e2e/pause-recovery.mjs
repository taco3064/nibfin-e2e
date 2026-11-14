import { fixtureBudget } from './fixture-budget.mjs';
import { readPauseSnapshot, readPauseAdmission } from './pause-observations.mjs';

// Read-only reconciliation of the exact invocation; never repeats admission.
export async function reconcilePauseExecution(inventory, caller, bounds = {}) {
  try {
    const budget = fixtureBudget(bounds);
    const call = action => budget.call(action);
    return await inventory.exclusive(async (state, save) => {
      const pending = state.pauseExecution;
      if (pending?.state !== 'intent') return { state: 'passing' };
      const evidence = await call(signal =>
        caller.readPauseEvidence(structuredClone(pending.binding), signal));
      const result = await readPauseAdmission(pending.binding, evidence?.admission,
        pending.snapshot, caller, call);
      const snapshot = await readPauseSnapshot(pending.binding,
        target => call(signal => caller.observe(target, signal)));
      if (!result || JSON.stringify(snapshot) !== JSON.stringify(pending.snapshot)) {
        return { state: 'unverified', code: 'PAUSE_EFFECT_UNKNOWN' };
      }
      state.pauseExecution = { ...pending, state: 'observed', result };
      await save();
      return { state: 'passing' };
    });
  } catch { return { state: 'unverified', code: 'PAUSE_EFFECT_UNKNOWN' }; }
}
