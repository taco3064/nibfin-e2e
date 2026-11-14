import { withPreparedSources } from './sources.mjs';
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

// This convenience owner covers one scenario run. For tests followed by release
// preparation, retain a set with withPreparedSources and pass its sources to run.
export async function runPrepared(entries, groups = [], options = {}) {
  const selected = select(entries, groups);
  if (!selected.some(scenario => !scenario.policyReason)) {
    return run(entries, groups, options);
  }
  let document;
  try {
    return await withPreparedSources(async prepared => {
      document = await run(entries, groups, {
        ...options, sources: prepared.sources,
      });
      return document;
    }, { ...options.sourceOptions, diagnostic: options.diagnostic });
  } catch (error) {
    return report(document?.results ?? [], [...(document?.errors ?? []), String(error)]);
  }
}
