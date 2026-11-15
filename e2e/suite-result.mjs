import { sourceIdentities } from './release-contract.mjs';

export const suitePhases = Object.freeze([
  'provision', 'install', 'delivery', 'failure', 'cleanup',
]);
export const suiteStates = Object.freeze([
  'unobserved', 'missing-input', 'passed', 'failed', 'unresolved',
]);
export const suiteId = value => typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);
export const sameBinding = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

export function unobservedPhases() {
  return Object.fromEntries(suitePhases.map(name => [name,
    { state: 'unobserved', code: 'NOT_OBSERVED', resources: [] }]));
}

export function suiteSources(sources) {
  return sourceIdentities(sources);
}

// Only bounded identity fields cross the public/durable boundary. Raw adapter
// values, diagnostics and capability objects are deliberately not serialized.
export function phaseObservation(value) {
  if (!value || !suiteStates.includes(value.state) ||
      !['passed', 'failed', 'unresolved'].includes(value.state) ||
      !suiteId(value.code) || !Array.isArray(value.resources) ||
      value.resources.length > 128 || !value.resources.every(suiteId)) {
    throw new Error('SUITE_OBSERVATION_INVALID');
  }
  return { state: value.state, code: value.code,
    resources: [...new Set(value.resources)] };
}

export function suiteReport(record) {
  const phases = Object.fromEntries(suitePhases.map(name =>
    [name, structuredClone(record.phases[name])]));
  const pending = [...new Set(suitePhases.flatMap(name => {
    const row = phases[name];
    return row.state === 'unresolved' ? [row.intent, ...row.resources] : [];
  }).filter(Boolean))];
  const cleaned = phases.cleanup.state === 'passed';
  if (!cleaned) pending.push(...record.resources);
  return { schemaVersion: 1, kind: 'suite', runId: record.runId,
    sources: structuredClone(record.sources), provenance: record.provenance,
    sourceOwner: record.sourceOwner,
    binding: record.binding, phases, pending: [...new Set(pending)],
    cleanup: cleaned ? 'complete' : 'pending',
    outcome: suitePhases.every(name => phases[name].state === 'passed') &&
      pending.length === 0 ? 'passed' : 'non-passing' };
}

// A suite summary is an additional prerequisite, never native coverage evidence.
export function requireNativeSuite(value, prepared, invocation) {
  const sources = prepared.sources;
  if (value?.schemaVersion !== 1 || value.kind !== 'suite' ||
      !suiteId(value.runId) || value.provenance !== 'native' ||
      !suiteId(value.sourceOwner) || value.sourceOwner !== prepared.ownershipId ||
      !sameBinding(value.sources, suiteSources(sources)) ||
      value.binding !== `${invocation.repository}/${invocation.runId}/` +
        invocation.attempt || value.outcome !== 'passed' ||
      value.cleanup !== 'complete' || !Array.isArray(value.pending) ||
      value.pending.length || suitePhases.some(name =>
        value.phases?.[name]?.state !== 'passed')) {
    throw new Error('SUITE: native bound complete result required');
  }
}
