import { register, scenarios } from './registry.mjs';
import { outcomes } from './schema.mjs';
import { catalog, products, validateCatalog } from './coverage-catalog.mjs';
import { associations, validateDocument } from './coverage-input.mjs';

function combined(rows) {
  if (!rows.length) return 'unverified';
  for (const state of ['failing', 'blocked', 'unverified', 'skipped-by-policy']) {
    if (rows.some(row => row.outcome === state)) return state;
  }
  return 'passed';
}
function totals(behaviors) {
  const denominator = behaviors.length;
  const exercised = behaviors.filter(row => row.exercised).length;
  const passed = behaviors.filter(row => row.outcome === 'passed').length;
  return { catalogued: denominator, exercised, passed,
    exercisedPercent: denominator ? exercised * 100 / denominator : null,
    passedPercent: denominator ? passed * 100 / denominator : null,
    outcomes: Object.fromEntries(outcomes.map(state =>
      [state, behaviors.filter(row => row.outcome === state).length])) };
}
function slice(entries, key, values) {
  return Object.fromEntries(values.map(value =>
    [value, totals(entries.filter(row => row[key] === value))]));
}
function calculateRun(run, entries, registry) {
  const { document, environment = null, evidence = [], provenance = 'unknown' } = run;
  if (environment !== null &&
      (typeof environment !== 'string' || !environment.trim())) {
    throw new Error('Invalid environment');
  }
  if (!['unknown', 'local-test', 'native-observation'].includes(provenance)) {
    throw new Error('Invalid provenance');
  }
  const results = validateDocument(document, registry);
  const links = associations(evidence, results);
  const rows = entries.map(behavior => {
    const mapped = behavior.scenarioIds.map(id => {
      const observation = results.get(id);
      const context = links.get(id);
      return { id, registered: registry.has(id),
        outcome: observation?.outcome ?? 'unverified',
        reason: observation?.reason ?? null,
        exercised: observation?.outcome === 'passed' || context?.exercised === true,
        evidenceUrls: context?.urls ?? [], rejectedUrls: context?.rejectedUrls ?? 0 };
    });
    return { ...behavior, scenarios: mapped, outcome: combined(mapped),
      exercised: mapped.length > 0 && mapped.every(row => row.exercised) };
  });
  const scenarioRows = [...registry.keys()].sort().map(id => ({
    id, outcome: results.get(id)?.outcome ?? 'unverified',
    observed: results.has(id),
    exercised: results.get(id)?.outcome === 'passed' || links.get(id)?.exercised === true,
  }));
  const summary = totals(rows);
  return { environment, provenance,
    complete: document.errors.length === 0 && rows.length > 0 &&
      rows.every(row => row.outcome === 'passed'),
    errors: structuredClone(document.errors),
    totals: summary,
    byProduct: slice(rows, 'product', products),
    byCategory: slice(rows, 'category', [...new Set(rows.map(row => row.category))]),
    scenarios: scenarioRows, behaviors: rows,
    productionPassing: provenance === 'native-observation' && environment !== null
      ? summary.passed : 0 };
}
export function calculateCoverage(options = {}) {
  const entries = validateCatalog(options.catalog ?? catalog);
  const registered = register(options.registry ?? scenarios);
  const registry = new Map(registered.map(row => [row.id, row]));
  const empty = { schemaVersion: 1, results: [], errors: [] };
  const runs = options.runs ?? [{ document: empty }];
  if (!Array.isArray(runs) || !runs.length) throw new Error('Runs must be nonempty');
  const environments = new Set();
  const reports = runs.map(run => {
    if (!run || typeof run !== 'object') throw new Error('Invalid run');
    const report = calculateRun(run, entries, registry);
    if (environments.has(report.environment)) {
      throw new Error('Ambiguous duplicate environment');
    }
    environments.add(report.environment);
    return report;
  });
  return { schemaVersion: 1, target: 'current main', catalogued: entries.length,
    registeredScenarios: registry.size, environments: reports };
}
export function exportCoverage(report) {
  return JSON.stringify(report, null, 2) + '\n';
}
