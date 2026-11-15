import { fixtureBudget } from './fixture-budget.mjs';
import { observePressure, validPressureBinding } from './pressure-observations.mjs';

// Host capabilities must be supplied by the separately adopted test-host route.
// There is deliberately no shell, WSL administration, or production fallback.
export async function runPressureSmoke(binding, host, limits) {
  const recoveryState = { experimentId: binding?.experimentId,
    effects: 'unknown', resources: null, preserveGuests: null };
  const result = (code, extra = {}) => ({ recoveryState, state: 'unverified', code,
    liveVerified: false, cleanup: 'unresolved', ...extra });
  if (!validPressureBinding(binding)) return result('PRESSURE_BINDING_REQUIRED');
  if (!limits || !['timeoutMs', 'requestTimeoutMs', 'requests', 'operations']
    .every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0)) {
    return result('FINITE_BOUNDS_REQUIRED');
  }
  let budget;
  try { budget = fixtureBudget(limits); }
  catch { return result('FINITE_BOUNDS_REQUIRED'); }
  if (host?.adoptedTestHost !== true || host.production !== false ||
      !['inventory', 'experiment', 'observe', 'cleanup'].every(key =>
        typeof host[key] === 'function')) return result('CAPABILITY_UNAVAILABLE');
  let before;
  try { before = await budget.call(signal => host.inventory(binding, signal)); }
  catch { return result('HOST_INVENTORY_UNAVAILABLE'); }
  if (before?.complete !== true || !Array.isArray(before.activeGuests) ||
      !before.activeGuests.every(id => typeof id === 'string' && id.length)) {
    return result('HOST_INVENTORY_UNAVAILABLE');
  }
  recoveryState.preserveGuests = [...before.activeGuests];
  // Only the host authority can admit Writers. Never replay an uncertain call.
  const constraints = Object.freeze({ preserveGuests: [...before.activeGuests],
    restartWSL: false, reconfigureWSL: false, disposableOnly: true });
  let execution;
  try {
    budget.operation();
    execution = await budget.call(signal => host.experiment(binding,
      constraints, signal));
  } catch { return result('EXPERIMENT_EFFECT_UNKNOWN'); }
  if (execution?.experimentId !== binding?.experimentId ||
      execution.effects !== 'reconciled' || !Array.isArray(execution.resources)) {
    return result('EXPERIMENT_EFFECT_UNKNOWN');
  }
  recoveryState.effects = execution.effects;
  recoveryState.resources = execution.resources.map(r => ({ id: r?.id,
    owner: r?.owner, disposable: r?.disposable, retired: r?.retired }));
  let evidence;
  try { evidence = await budget.call(signal => host.observe(binding, signal)); }
  catch { return result('PRESSURE_EVIDENCE_UNAVAILABLE'); }
  const observed = observePressure(binding, evidence);
  if (observed.state !== 'passed') return { ...result(observed.code),
    state: observed.state };
  const resources = execution.resources;
  if (resources.some(r => !r || typeof r.id !== 'string' || !r.id ||
      r.owner !== binding.experimentId || r.disposable !== true ||
      r.retired !== true || before.activeGuests.includes(r.id)) ||
      new Set(resources.map(r => r.id)).size !== resources.length) {
    return result('CLEANUP_OWNERSHIP_UNVERIFIED');
  }
  let after;
  try { after = await budget.call(signal => host.inventory(binding, signal)); }
  catch { return result('HOST_PRESERVATION_UNVERIFIED'); }
  if (after?.complete !== true || !Array.isArray(after.activeGuests) ||
      !before.activeGuests.every(id => after.activeGuests.includes(id))) {
    return result('HOST_PRESERVATION_UNVERIFIED');
  }
  try {
    budget.operation();
    const cleanup = await budget.call(signal => host.cleanup(binding,
      structuredClone(resources), constraints, signal));
    if (cleanup?.complete !== true || cleanup.effects !== 'reconciled') {
      return result('CLEANUP_UNVERIFIED');
    }
  } catch { return result('CLEANUP_EFFECT_UNKNOWN'); }
  try {
    const final = await budget.call(signal => host.inventory(binding, signal));
    if (final?.complete !== true || !Array.isArray(final.activeGuests) ||
        !before.activeGuests.every(id => final.activeGuests.includes(id))) {
      return result('HOST_PRESERVATION_UNVERIFIED');
    }
  } catch { return result('HOST_PRESERVATION_UNVERIFIED'); }
  return { ...observed, evidenceLevel: 'test-host-observation',
    liveVerified: false, cleanup: 'confirmed' };
}
