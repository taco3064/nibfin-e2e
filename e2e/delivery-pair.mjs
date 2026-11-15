import { randomUUID } from 'node:crypto';
import { fixtureDefinition } from './fixture-definition.mjs';
import { fixtureBudget } from './fixture-budget.mjs';
import { capabilityNames, positive, same } from './delivery-contract.mjs';
import { validAssignee } from './fixture-issue.mjs';
import { deliveryIsolation } from './delivery-isolation.mjs';
import { finishDelivery } from './delivery-observation.mjs';
import { assertConcurrency } from './concurrency-assertions.mjs';
import { verifyConcurrencyNative } from './concurrency-protected.mjs';
import { withDeliverySources } from './delivery-sources.mjs';

export const javascriptRequests = Object.freeze([
  Object.freeze({ path: 'ready.mjs', stdout: 'NIBFIN_E2E_READY\n' }),
  Object.freeze({ path: 'ready-b.mjs', stdout: 'NIBFIN_E2E_READY_B\n' }),
].map(item => Object.freeze({ ...item,
  content: `process.stdout.write(${JSON.stringify(item.stdout)});\n` })));
const capabilities = [...capabilityNames, 'readConcurrencyEvidence',
  'readIsolationEvidence'];
const valid = request => /^[\w.-]+\/[\w.-]+$/.test(request?.repository ?? '') &&
  validAssignee(request?.assignee);
const admissionKeys = ['runRepository', 'runId', 'attempt', 'jobId'];

// The paired chain must also be independent across Issues, not just within each.
function independent(deliveries, history) {
  const [a, b] = deliveries;
  if (a.candidate.id === b.candidate.id || a.candidate.shape === b.candidate.shape ||
      a.pull.number === b.pull.number || a.pull.head === b.pull.head ||
      a.stages.some(s => b.stages.some(t => s.execution.id === t.execution.id ||
        s.execution.sessionId === t.execution.sessionId)) ||
      a.admissions.some(s => b.admissions.some(t => same(s, t, admissionKeys)))) {
    return false;
  }
  return deliveries.every(e => {
    const stage = e.stages.find(s => s.stage === 'deliver');
    return history.writers.some(w => w.issue === stage.issue &&
      w.executionId === stage.execution.id && same(w, stage.admission,
      admissionKeys)) && history.admissions.filter(h => h.issue === stage.issue)
      .every(h => e.admissions.some(a => same(a, h, admissionKeys)));
  });
}

async function execute(request, caller, bounds, sources, lifecycle) {
  const mode = caller?.mode === 'fixture' ? 'fixture' : 'live';
  const output = (state, code) => ({ state, code, mode, liveVerified: false });
  if (!valid(request)) return output('blocked', 'INVALID_REQUEST');
  if (!['fixture', 'live'].includes(caller?.mode)) {
    return output('blocked', 'PROVENANCE_REQUIRED');
  }
  for (const name of capabilities) if (typeof caller?.[name] !== 'function') {
    return { ...output('blocked', 'CAPABILITY_UNAVAILABLE'), capability: name };
  }
  const owned = [], bindings = [], deliveries = [];
  let phase = 'FIXTURE_UNAVAILABLE';
  let outcome;
  let triggered = false;
  let safe = false;
  try {
    const budget = fixtureBudget(bounds);
    const call = action => budget.call(action);
    const pair = { requestId: randomUUID(), repository: request.repository,
      case: 'independent', issues: [] };
    for (const program of javascriptRequests) {
      const definition = fixtureDefinition('javascript-delivery', request.repository);
      const fixture = await call(signal => caller.createFixture(definition, signal));
      if (fixture?.lifecycle) owned.push(fixture.lifecycle);
      if (!same(fixture?.definition, definition, Object.keys(definition)) ||
          !['setup', 'prepareDelivery', 'teardown'].every(name =>
            typeof fixture?.lifecycle?.[name] === 'function')) throw new Error();
      const setup = await call(() => fixture.lifecycle.setup('issue'));
      const record = setup?.resources?.[0];
      if (setup?.state !== 'passing' || setup.resources.length !== 1 ||
          record.kind !== 'issue' || record.state !== 'owned' ||
          !positive(record.native?.number) || !positive(record.native?.id) ||
          bindings.some(b => b.issue === record.native.number ||
            b.issueId === record.native.id)) throw new Error();
      const binding = { requestId: randomUUID(), pairRequestId: pair.requestId,
        repository: request.repository,
        issue: record.native.number, issueId: record.native.id,
        path: `${definition.generatedRoot}${program.path}`, content: program.content,
        stdout: program.stdout };
      bindings.push(binding);
      pair.issues.push(binding.issue);
      phase = 'ISSUE_PREPARATION_UNCONFIRMED';
      const body = `Implement independent JavaScript request ${binding.requestId}.\n` +
        `Create only ${binding.path} with this exact content:\n` +
        `${JSON.stringify(binding.content)}\n` +
        `Running it must produce exactly ${JSON.stringify(binding.stdout)}.\n` +
        'This request has no dependency on any other fixture Issue.';
      const prepared = await call(() => fixture.lifecycle.prepareDelivery(body,
        request.assignee, { repository: binding.repository, number: binding.issue }));
      if (prepared?.state !== 'passing') throw new Error();
    }
    // Dispatch both before awaiting either terminal delivery observation.
    for (const binding of bindings) {
      phase = 'TRIGGER_EFFECT_UNKNOWN';
      triggered = true;
      const wake = await call(signal => caller.trigger({ ...binding,
        sources: sources?.sources, sourceRoot: sources?.root }, signal));
      if (!same(wake, binding, ['repository', 'issue']) ||
          wake.status !== 'completed') throw new Error();
      binding.wake = wake;
    }
    if (lifecycle) {
      phase = 'FAULT_LIFECYCLE_UNVERIFIED';
      await lifecycle(bindings, { sourceRoot: sources?.root });
    }
    for (const binding of bindings) {
      const result = await finishDelivery(binding, caller, call, bounds,
        evidence => deliveries.push(evidence));
      if (result.state !== 'passed') { outcome = result; break; }
      phase = 'ISOLATION_PRODUCER_UNAVAILABLE';
      const isolation = await call(signal => caller.readIsolationEvidence(
        structuredClone(binding), signal));
      if (!deliveryIsolation(binding, isolation, mode)) throw new Error();
    }
    phase = 'PROTECTED_HISTORY_UNAVAILABLE';
    const history = await call(signal => caller.readConcurrencyEvidence(
      structuredClone({ ...pair, deliveries: bindings }), signal));
    const concurrency = assertConcurrency(pair, history);
    safe = concurrency.state === 'passed' && history.effects === 'reconciled' &&
      history.writers.every(w => Number.isSafeInteger(w.end));
    if (!outcome && concurrency.state !== 'passed') outcome = concurrency;
    if (!outcome) {
      phase = 'PAIRED_ASSOCIATION_UNAVAILABLE';
      if (deliveries.length !== 2 || !independent(deliveries, history)) {
        throw new Error();
      }
      phase = 'NATIVE_EXECUTION_UNAVAILABLE';
      if (!await verifyConcurrencyNative(pair, history, call, caller)) {
        throw new Error();
      }
      outcome = { ...output('passed', mode === 'live'
        ? 'LIVE_PAIRED_DELIVERY_OBSERVED' : 'SYNTHETIC_PAIRED_DELIVERY_CONFIRMED'),
      liveVerified: mode === 'live' };
    }
  } catch { outcome ??= output('unverified', phase); }
  outcome = { ...output(outcome.state, outcome.code), ...outcome };
  if (triggered && !safe) return { ...outcome, state: 'unverified',
    liveVerified: false, cleanup: 'unresolved' };
  for (const lifecycle of owned.reverse()) {
    try {
      const result = await fixtureBudget(bounds).call(() => lifecycle.teardown());
      if (result?.state === 'passing') continue;
    } catch { /* Retain inventory and source ownership for authorized recovery. */ }
    outcome = { ...outcome, state: 'unverified', liveVerified: false,
      cleanup: 'unresolved' };
  }
  return outcome;
}

export function runDeliveryPair(request, caller, bounds = {}) {
  return runDeliveryPairWithLifecycle(request, caller, bounds);
}

// Internal protected composition: lifecycle may settle a fault before terminal
// delivery observation. Returned Wake identities still require native validation.
export async function runDeliveryPairWithLifecycle(request, caller, bounds = {},
  lifecycle) {
  if (caller?.mode !== 'live' || !valid(request) ||
      capabilities.some(name => typeof caller?.[name] !== 'function')) {
    return execute(request, caller, bounds, undefined, lifecycle);
  }
  try {
    return await withDeliverySources(sources => execute(request, caller, bounds,
      sources, lifecycle));
  } catch {
    return { state: 'unverified', code: 'SOURCE_PREPARATION_UNAVAILABLE',
      mode: 'live', liveVerified: false };
  }
}

// The release gate already owns these sources. Never acquire or dispose a
// second set here; unresolved effects are returned to that owner for recovery.
export function runDeliveryPairPrepared(request, caller, prepared, bounds = {},
  lifecycle) {
  if (!prepared || prepared.disposed !== false || !prepared.sources) {
    return Promise.resolve({ state: 'blocked', code: 'PREPARED_SOURCES_REQUIRED',
      mode: caller?.mode, liveVerified: false });
  }
  return execute(request, caller, bounds, prepared, lifecycle);
}
