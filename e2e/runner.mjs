import { sourceIdentities } from './source-selection.mjs';
import { selectedSourceInputs } from './source-requirements.mjs';
import { withPreparedSources } from './sources.mjs';
import { select } from './registry.mjs';
import { execute } from './execution.mjs';
import { report, result } from './schema.mjs';

export async function run(entries, groups = [], options = {}) {
  const selected = select(entries, groups);
  const results = [];
  for (const scenario of selected) {
    const failures = scenario.policyReason ? [] : scenario.sources.filter(
      id => options.availability && !options.availability[id]?.available,
    );
    if (failures.length) {
      results.push(result(scenario, 'failing', 'SOURCE_PREPARATION_ERROR',
        failures.map(id => `${id}: ${options.availability[id]?.error}`).join('; ')));
    } else {
      const sources = options.availability
        ? selectedSourceInputs(options.sources, scenario.sources) : options.sources;
      const outcome = await execute(scenario, { ...options, sources });
      results.push(outcome);
      if (outcome.reason.code === 'TERMINATION_ERROR') break;
    }
  }
  const errors = selected.length ? [] : ['NO_SCENARIOS: nothing was verified'];
  return report(results, errors);
}

// This convenience owner covers one scenario run. For tests followed by release
// preparation, retain a set with withPreparedSources and pass its sources to run.
export async function runPrepared(entries, groups = [], options = {}) {
  const selected = select(entries, groups);
  if (!selected.some(scenario => !scenario.policyReason)) {
    return { ...await run(entries, groups, options), sources: [] };
  }
  let document;
  let identities = [];
  try {
    return await withPreparedSources(async prepared => {
      identities = sourceIdentities(prepared.sources);
      document = await run(entries, groups, {
        ...options, sources: prepared.sources, availability: prepared.availability,
      });
      document.sources = identities;
      if (document.results.some(item => item.reason.code === 'TERMINATION_ERROR')) {
        throw Object.assign(new Error('SOURCE_TERMINATION_UNKNOWN'), {
          terminationUnknown: true,
        });
      }
      return document;
    }, { ...options.sourceOptions, diagnostic: options.diagnostic,
      requirements: [...new Set(selected.filter(item => !item.policyReason)
        .flatMap(item => item.sources))],
    });
  } catch (error) {
    return {
      ...report(document?.results ?? [], [...(document?.errors ?? []), String(error)]),
      sources: error.sourceIdentities ?? identities,
    };
  }
}

// In-process protected framework entry. No CLI input selects a capability or
// executable; ordinary scenario/group consumers keep the existing report shape.
export async function runSuite(coordinator, request) {
  if (typeof coordinator?.run !== 'function') {
    throw new Error('SUITE_CAPABILITY_UNAVAILABLE');
  }
  return coordinator.run(request);
}
