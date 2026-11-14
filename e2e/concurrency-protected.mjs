import { randomUUID } from 'node:crypto';
import { fixtureDefinition } from './fixture-definition.mjs';
import { fixtureBudget } from './fixture-budget.mjs';
import { positive, same } from './delivery-contract.mjs';
import { withDeliverySources } from './delivery-sources.mjs';
import { matches } from './github-resources.mjs';
import { cases, assertConcurrency } from './concurrency-assertions.mjs';

const capabilities = ['createFixture', 'trigger', 'readConcurrencyEvidence', 'observe'];
const valid = request => request && cases.includes(request.case) &&
  /^[\w.-]+\/[\w.-]+$/.test(request.repository ?? '') && positive(request.memberId);

async function nativeEvidence(binding, evidence, call, caller) {
  for (const a of evidence.admissions) {
    const { runRepository: repository, runId, attempt } = a;
    for (const kind of ['run', 'jobs']) {
      const target = { kind, repository, runId, attempt };
      const observed = await call(signal => caller.observe(target, signal));
      if (observed?.complete !== true ||
          !same(observed.target, target, Object.keys(target))) return false;
      const items = kind === 'run' ? [observed.data] : observed.data;
      if (!Array.isArray(items) || items.length > 1000 ||
          items.some(item => !matches(item, target)) ||
          new Set(items.map(item => item.id)).size !== items.length) return false;
      if (kind === 'jobs' && !items.some(job => job.id === a.jobId &&
          job.runner_id === a.runnerId)) return false;
    }
  }
  // Issue identities are also independently read, including queued Offline cases.
  for (const number of binding.issues) {
    const target = { kind: 'issue', repository: binding.repository, number };
    const value = await call(signal => caller.observe(target, signal));
    if (value?.complete !== true || !same(value.target, target, Object.keys(target)) ||
        !matches(value.data, target)) return false;
  }
  return true;
}

async function execute(request, caller, bounds, sources) {
  const mode = caller?.mode === 'fixture' ? 'fixture' : 'live';
  const output = (state, code) => ({ state, code, mode, liveVerified: false });
  if (!valid(request)) return output('blocked', 'INVALID_REQUEST');
  if (!['live', 'fixture'].includes(caller?.mode)) {
    return output('blocked', 'PROVENANCE_REQUIRED');
  }
  for (const name of capabilities) if (typeof caller?.[name] !== 'function') {
    return { ...output('blocked', 'CAPABILITY_UNAVAILABLE'), capability: name };
  }
  const owned = [];
  let outcome;
  let phase = 'FIXTURE_UNAVAILABLE';
  let triggered = false;
  let safe = false;
  try {
    const budget = fixtureBudget(bounds);
    const call = action => budget.call(action);
    const binding = { ...request, requestId: randomUUID(), issues: [], wakes: [] };
    for (let i = 0; i < (request.case === 'independent' ? 2 : 1); i++) {
      const definition = fixtureDefinition(`concurrency-${request.case}`,
        request.repository);
      const fixture = await call(signal => caller.createFixture(definition, signal));
      // Retain every acquired lifecycle even when the provider returns a bad binding.
      if (fixture?.lifecycle) owned.push(fixture.lifecycle);
      if (!same(fixture?.definition, definition, Object.keys(definition)) ||
          !['setup', 'mutateIssue', 'teardown'].every(name =>
            typeof fixture?.lifecycle?.[name] === 'function')) throw new Error();
      const setup = await call(() => fixture.lifecycle.setup('issue'));
      const resources = setup?.resources;
      if (setup?.state !== 'passing' || resources?.length !== 1 ||
          resources[0].kind !== 'issue' || resources[0].state !== 'owned' ||
          !positive(resources[0].native?.number) ||
          !positive(resources[0].native?.id)) throw new Error();
      const issue = resources[0].native.number;
      if (binding.issues.includes(issue)) throw new Error();
      binding.issues.push(issue);
      phase = 'ISSUE_MUTATION_UNCONFIRMED';
      const body = `Controlled ${request.case} work.\n` +
        `Create ${definition.generatedRoot}result.txt containing "complete".\n` +
        `Independent request ${binding.requestId}; no other Issue dependency.`;
      const mutation = await call(() => fixture.lifecycle.mutateIssue(
        'edit-issue-body', body, { repository: request.repository, number: issue }));
      if (mutation?.state !== 'passing') throw new Error();
    }
    // Trigger both Issues without waiting for either delivery to complete.
    for (const issue of request.case === 'duplicate'
      ? [binding.issues[0], binding.issues[0]] : binding.issues) {
      const wake = { wakeId: randomUUID(), issue };
      binding.wakes.push(wake);
      phase = 'TRIGGER_EFFECT_UNKNOWN';
      triggered = true;
      const receipt = await call(signal => caller.trigger({
        ...structuredClone(binding), ...wake,
        sources: sources?.sources, sourceRoot: sources?.root }, signal));
      if (!same(receipt, wake, ['wakeId', 'issue']) ||
          receipt.status !== 'completed') throw new Error();
    }
    phase = 'PROTECTED_HISTORY_UNAVAILABLE';
    const evidence = await call(signal => caller.readConcurrencyEvidence(
      structuredClone(binding), signal));
    const assertion = assertConcurrency(binding, evidence);
    outcome = output(assertion.state, assertion.code);
    safe = evidence?.coverage?.writers === true &&
      evidence?.coverage?.admissions === true &&
      evidence?.effects === 'reconciled' && Array.isArray(evidence.writers) &&
      evidence.writers.every(w => Number.isSafeInteger(w.end)) &&
      same(evidence, binding, ['requestId', 'repository', 'case']) &&
      JSON.stringify(evidence.issues) === JSON.stringify(binding.issues);
    if (assertion.state === 'passed') {
      phase = 'NATIVE_EXECUTION_UNAVAILABLE';
      if (!await nativeEvidence(binding, evidence, call, caller)) throw new Error();
      outcome = { ...outcome, liveVerified: mode === 'live',
        code: mode === 'live' ? 'LIVE_CONCURRENCY_OBSERVED' :
          'SYNTHETIC_CONCURRENCY_CONFIRMED' };
    }
  } catch { outcome = output('unverified', phase); }
  if (triggered && !safe) return { ...outcome, state: 'unverified',
    liveVerified: false, cleanup: 'unresolved' };
  for (const lifecycle of owned.reverse()) {
    try {
      const cleaned = await fixtureBudget(bounds).call(() => lifecycle.teardown());
      if (cleaned?.state === 'passing') continue;
    } catch { /* Retain the inventory; never expose provider errors. */ }
    outcome = { ...outcome, state: 'unverified', liveVerified: false,
      cleanup: 'unresolved' };
  }
  return outcome;
}

export async function runConcurrency(request, caller, bounds = {}) {
  if (caller?.mode !== 'live' || !valid(request) ||
      capabilities.some(name => typeof caller?.[name] !== 'function')) {
    return execute(request, caller, bounds);
  }
  try {
    return await withDeliverySources(sources => execute(request, caller, bounds,
      sources));
  } catch {
    return { state: 'unverified', code: 'SOURCE_PREPARATION_UNAVAILABLE',
      mode: 'live', liveVerified: false };
  }
}
