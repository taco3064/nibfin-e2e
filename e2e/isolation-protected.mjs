import { randomUUID } from 'node:crypto';
import { fixtureBudget } from './fixture-budget.mjs';
import { githubObserver } from './github-observer.mjs';
import { compareInstallationResult } from './runner-observations.mjs';
import { compareAdmission, validAssignment, admissionCases } from
  './isolation-contract.mjs';

function installationMatches(installation, expected, mode) {
  const result = compareInstallationResult(installation);
  if (!(result.outcome === 'passed' || mode === 'synthetic' &&
      result.code === 'SYNTHETIC_INSTALLATION_MATCHED')) return false;
  const { binding: b, inventory: i, observation: o } = installation;
  const s = expected.slot;
  if (!s || i.owner !== b.owner || i.hostId !== b.hostId ||
      s.hostId !== b.hostId || s.repositoryId !== b.repositoryId ||
      s.memberId !== b.memberId || expected.negative.repository !== b.repository ||
      expected.eligible.repository !== b.repository ||
      !i.repositories?.some(r => r.id === b.repositoryId &&
        r.repository === b.repository)) return false;
  const runner = o.runners.find(r => r.id === s.runnerId);
  return runner && i.runners.some(r => r.id === runner.id &&
    r.name === runner.name && r.localId === runner.id &&
    r.localName === runner.name && r.repositoryId === b.repositoryId &&
    r.memberId === b.memberId && r.endpoint === o.endpoint && r.shared === true) &&
    [expected.negative, expected.eligible].every(a =>
      a.runnerId === runner.id && a.runnerName === runner.name);
}

// Protected composition only; never pass caller to a scenario worker. Caller
// implements fixed authorized operations, owns all effects, and must reconcile
// timed-out launches in terminate() before confirming cleanup. No callback is
// selected from observation data. Exceptions and raw provider data stay private.
export async function observeIsolation({ installation, expected, caller,
  mode = 'synthetic', bounds = {}, observerBounds = {} }) {
  const unavailable = code => ({ mode: mode === 'live' ? 'live' : 'synthetic',
    state: 'unverified', code });
  let authorized = false;
  let surface;
  let result;
  let terminated = false;
  let cleaned = false;
  try {
    const budget = fixtureBudget(bounds);
    if (!['live', 'synthetic'].includes(mode) ||
        !admissionCases.includes(expected?.case)) return unavailable('CASE_UNKNOWN');
    if (expected.applicable === false && ['fork', 'route'].includes(expected.case)) {
      return { mode, state: 'inapplicable', code: 'CASE_INAPPLICABLE' };
    }
    if (expected.applicable !== true || !validAssignment(expected.negative) ||
        !validAssignment(expected.eligible) ||
        !installationMatches(installation, expected, mode)) {
      return unavailable('INSTALLATION_BINDING_UNPROVEN');
    }
    if (!caller || !['authorize', 'openSurface', 'executeNegative',
      'executeEligible', 'readRejection', 'readSlot', 'provider', 'terminate']
      .every(k => typeof caller[k] === 'function')) {
      return unavailable('PROTECTED_CALLER_UNAVAILABLE');
    }
    // Copy the request before exposing it to callbacks or awaiting authorization.
    expected = structuredClone(expected);
    const binding = structuredClone(installation.binding);
    if (await budget.call(signal => caller.authorize({ binding,
      expected: structuredClone(expected), signal })) !== true) {
      return unavailable('PROTECTED_CALLER_UNAUTHORIZED');
    }
    authorized = true;
    const observe = githubObserver(caller.provider, observerBounds);
    // openSurface must reconcile any interrupted creation in terminate().
    surface = await budget.call(signal => caller.openSurface(signal));
    const negativeSentinel = surface.reserve(randomUUID());
    const eligibleSentinel = surface.reserve(randomUUID());
    expected = { ...expected, negativeSentinel, eligibleSentinel };
    const observed = {};
    async function acquire(key, execute, token) {
      const assignment = expected[key];
      budget.operation();
      await budget.call(signal => execute.call(caller, {
        case: expected.case, assignment: structuredClone(assignment),
        sentinel: token, signal,
      }));
      observed[key] = {};
      for (const kind of ['run', 'jobs']) {
        observed[key][kind] = await budget.call(() => observe({ kind,
          repository: assignment.repository, runId: assignment.runId,
          attempt: assignment.attempt, sha: assignment.sha }));
      }
      observed[`${key}Slot`] = await budget.call(signal => caller.readSlot({
        assignment: structuredClone(assignment), signal,
      }));
      observed[`${key}Sentinel`] = await budget.call(() => surface.inspect(token));
    }
    await acquire('negative', caller.executeNegative, negativeSentinel);
    observed.rejection = await budget.call(signal => caller.readRejection({
      assignment: structuredClone(expected.negative), signal,
    }));
    await acquire('eligible', caller.executeEligible, eligibleSentinel);
    result = observed;
  } catch { result = null; }
  finally {
    // Independent bounded recovery budget is reserved even after acquisition
    // exhausts its deadline. An uncertain termination forbids deleting evidence.
    if (authorized) {
      const recovery = fixtureBudget(bounds);
      try {
        terminated = await recovery.call(signal => caller.terminate(signal)) === true;
        if (terminated && surface && result) {
          // Inspect after confirmed termination so delayed negative writes cannot
          // disappear behind an earlier absence observation.
          result.negativeSentinel = await recovery.call(() =>
            surface.inspect(expected.negativeSentinel));
          result.eligibleSentinel = await recovery.call(() =>
            surface.inspect(expected.eligibleSentinel));
        }
      } catch { result = null; }
      if (terminated && surface) {
        try {
          cleaned = (await recovery.call(() => surface.cleanup()))?.cleaned === true;
        } catch { /* Retain the owned surface for authorized recovery. */ }
      }
    }
  }
  if (!terminated || !cleaned) return unavailable('TERMINATION_OR_CLEANUP_UNPROVEN');
  if (!result) return unavailable('ISOLATION_OBSERVATION_UNAVAILABLE');
  return compareAdmission(expected, { ...result, terminated, cleaned }, mode);
}
