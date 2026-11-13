import { select } from './registry.mjs';
import { execute } from './execution.mjs';
import { report } from './schema.mjs';

export async function run(entries, groups = [], options = {}) {
  const selected = select(entries, groups);
  const results = [];
  for (const scenario of selected) results.push(await execute(scenario, options));
  const errors = selected.length ? [] : ['NO_SCENARIOS: nothing was verified'];
  return report(results, errors);
}
