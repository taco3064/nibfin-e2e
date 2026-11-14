import { randomUUID } from 'node:crypto';
import { fixtureDefinition, defaultTarget } from './fixture-definition.mjs';
import { fixtureBudget } from './fixture-budget.mjs';
import { positive, same } from './delivery-contract.mjs';
import { withDeliverySources } from './delivery-sources.mjs';
import { readPauseSnapshot, pauseMutationObserved, readPauseAdmission }
  from './pause-observations.mjs';

const capabilities = ['createFixture', 'observe', 'admitPause', 'readPauseEvidence'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function execute(repository, caller, bounds, sources = {}) {
  const mode = caller?.mode === 'fixture' ? 'fixture' : 'live';
  const output = (state, code, extra = {}) => ({ state, code, mode,
    liveVerified: false, ...extra });
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') ||
      (mode === 'live' && repository !== defaultTarget)) {
    return output('blocked', 'INVALID_REQUEST');
  }
  for (const name of capabilities) {
    if (typeof caller?.[name] !== 'function') return output('blocked',
      'CAPABILITY_UNAVAILABLE', { capability: name });
  }
  if (!['fixture', 'live'].includes(caller.mode)) {
    return output('blocked', 'PROVENANCE_REQUIRED');
  }
  const budget = fixtureBudget(bounds);
  const call = action => budget.call(action);
  const observe = target => call(signal => caller.observe(target, signal));
  let owned;
  let outcome;
  let phase = 'PAUSE_FIXTURE_UNAVAILABLE';
  try {
    const definition = fixtureDefinition('pause-resume', repository);
    owned = await call(signal => caller.createFixture(definition, signal));
    if (!same(owned?.definition, definition, Object.keys(definition)) ||
        typeof owned?.inventory?.exclusive !== 'function') throw new Error();
    const setup = await call(() => owned.lifecycle.setup('issue'));
    const resource = setup?.resources?.[0];
    if (setup.state !== 'passing' || setup.resources.length !== 1 ||
        resource.kind !== 'issue' || resource.state !== 'owned' ||
        !['id', 'number'].every(key => positive(resource.native?.[key]))) {
      throw new Error();
    }
    const identity = { repository, issue: resource.native.number,
      issueId: resource.native.id };
    let previous = await readPauseSnapshot(identity, observe);
    if (!previous || previous.issue.labels.some(label => label.name === 'pause')) {
      throw new Error();
    }
    for (const adding of [true, false]) {
      phase = adding ? 'PAUSE_MUTATION_UNCONFIRMED' : 'RESUME_MUTATION_UNCONFIRMED';
      const mutation = await call(() => owned.lifecycle.mutateIssue(
        adding ? 'add-issue-label' : 'remove-issue-label', 'pause',
        { repository, number: identity.issue }));
      if (mutation?.state !== 'passing') throw new Error();
      const snapshot = await readPauseSnapshot(identity, observe);
      if (!pauseMutationObserved(previous, snapshot, adding)) throw new Error();
      const binding = { ...identity, requestId: randomUUID(),
        phase: adding ? 'paused' : 'resumed' };
      phase = 'PAUSE_ADMISSION_EFFECT_UNKNOWN';
      await owned.inventory.exclusive(async (state, save) => {
        if (state.pauseExecution?.state === 'intent') throw new Error();
        state.pauseExecution = { state: 'intent', binding, snapshot,
          ...(sources.sourceRoot ? { sourceRoot: sources.sourceRoot } : {}) };
        await save();
      });
      const expected = await call(signal => caller.admitPause(
        { ...structuredClone(binding), ...sources }, signal));
      const result = await readPauseAdmission(binding, expected, snapshot, caller, call);
      if (!result || !equal(snapshot, await readPauseSnapshot(identity, observe))) {
        throw new Error();
      }
      await owned.inventory.exclusive(async (state, save) => {
        state.pauseExecution = { ...state.pauseExecution, state: 'observed', result };
        await save();
      });
      previous = snapshot;
    }
    outcome = output('passed', mode === 'fixture' ? 'FIXTURE_CONTRACT_CONFIRMED' :
      'LIVE_PAUSE_ADMISSION_OBSERVED', { liveVerified: mode === 'live' });
  } catch { outcome = output('unverified', phase); }
  if (owned?.lifecycle) {
    try {
      const cleanup = await fixtureBudget(bounds).call(() => owned.lifecycle.teardown());
      if (cleanup?.state !== 'passing') throw new Error();
    } catch {
      return { ...outcome, state: 'unverified', liveVerified: false,
        cleanup: 'unresolved' };
    }
  }
  return outcome;
}

// Only protected composition supplies these capabilities. Workers get none.
export async function runPause(repository, caller, bounds = {}) {
  if (caller?.mode !== 'live' || repository !== defaultTarget ||
      capabilities.some(name => typeof caller?.[name] !== 'function')) {
    return execute(repository, caller, bounds);
  }
  try {
    return await withDeliverySources(prepared => execute(repository, caller, bounds,
      { sources: prepared.sources, sourceRoot: prepared.root }));
  } catch {
    return { state: 'unverified', code: 'SOURCE_PREPARATION_OR_CLEANUP_UNAVAILABLE',
      mode: 'live', liveVerified: false };
  }
}
