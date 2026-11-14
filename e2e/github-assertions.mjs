const result = (state, reason) => ({ state, reason });
export const unknown = reason => result('unknown', reason);
// Only satisfied assertions may be converted into scenario verification success.
export const confirmed = assertion => assertion?.state === 'satisfied';
export function assertObservation(observation, expected) {
  if (!observation?.complete) return unknown(observation?.reason ?? 'unavailable');
  const { target, data } = observation;
  if (!expected || typeof expected !== 'object') return unknown('expectation-required');
  const allowed = target.kind === 'pull' ? ['merged'] :
    target.kind === 'issue' ? ['closed', 'stateReason'] : ['ids', 'conclusion'];
  if (Object.keys(expected).some(key => !allowed.includes(key))) {
    return unknown('invalid-expectation');
  }
  if (expected.merged !== undefined) {
    if (typeof expected.merged !== 'boolean') return unknown('invalid-expectation');
    if (target.kind !== 'pull' || typeof data.merged !== 'boolean') {
      return unknown('native-merge-required');
    }
    return result(data.merged === expected.merged ? 'satisfied' : 'contradicted',
      'native-merge');
  }
  if (expected.closed !== undefined) {
    if (typeof expected.closed !== 'boolean') return unknown('invalid-expectation');
    if (target.kind !== 'issue' || !['open', 'closed'].includes(data.state)) {
      return unknown('native-closure-required');
    }
    if ((data.state === 'closed') !== expected.closed) {
      return result('contradicted', 'native-closure');
    }
    if (Object.hasOwn(expected, 'stateReason')) {
      if (!Object.hasOwn(data, 'state_reason')) return unknown('missing-reason');
      if (data.state_reason !== expected.stateReason) {
        return result('contradicted', 'closure-reason');
      }
    }
    return result('satisfied', 'native-closure');
  }
  if (!['run', 'jobs', 'checks'].includes(target.kind) ||
      typeof expected.conclusion !== 'string') return unknown('invalid-expectation');
  let items = [data];
  if (Array.isArray(data)) {
    if (!Array.isArray(expected.ids) || expected.ids.length === 0 ||
        !expected.ids.every(id => Number.isSafeInteger(id) && id > 0)) {
      return unknown('explicit-identities-required');
    }
    items = expected.ids.map(id => data.find(item => item.id === id));
  }
  if (items.some(item => !item)) return unknown('missing-object');
  if (items.some(item => item.status !== 'completed' ||
      typeof item.conclusion !== 'string')) return unknown('pending');
  return result(items.every(item => item.conclusion === expected.conclusion)
    ? 'satisfied' : 'contradicted', 'native-conclusion');
}
