import { fixtureBudget } from './fixture-budget.mjs';
import { canaryCases, compareCanaries } from './isolation-contract.mjs';

// An in-memory disposable surface. None of these names is a path, credential,
// registration ID, Docker endpoint or network destination on the actual host.
export function syntheticCanaryProbe({ accessible = [], unavailable = [] } = {}) {
  const synthetic = new Map(canaryCases.map(name => [name,
    Object.freeze({ name, value: `synthetic-${name}` })]));
  const grants = new Set(accessible.map(name => synthetic.get(name)));
  return async name => {
    if (!synthetic.has(name) || unavailable.includes(name)) return 'unavailable';
    return grants.has(synthetic.get(name)) ? 'accessible' : 'denied';
  };
}
export async function exerciseSyntheticCanaries(
  probe = syntheticCanaryProbe(), bounds = {},
) {
  const budget = fixtureBudget(bounds);
  const observations = [];
  for (const name of canaryCases) {
    let observation;
    try { observation = await budget.call(signal => probe(name, signal)); }
    catch { observation = 'unavailable'; }
    observations.push({ case: name, mode: 'synthetic', observation });
  }
  return compareCanaries(observations);
}
