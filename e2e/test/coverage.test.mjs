import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCoverage, exportCoverage } from '../coverage.mjs';
import { summarizeCoverage } from '../coverage-summary.mjs';
import { safeEvidenceUrl } from '../coverage-input.mjs';
import { outcomes, result, report } from '../schema.mjs';
import { scenarios } from '../registry.mjs';

const registry = ['a', 'b'].map(id => ({ id, group: 'local', title: 'Synthetic',
  timeoutMs: 1000, module: new URL('./fixtures/behaviors.mjs', import.meta.url).href }));
const catalog = [
  { id: 'delivery', product: 'Core', category: 'delivery', scenarioIds: ['a', 'b'] },
  { id: 'invoke', product: 'CLI', category: 'integration', scenarioIds: ['missing'] },
  { id: 'action', product: 'Action', category: 'integration', scenarioIds: [] },
];
const observation = (id, outcome = 'passed') =>
  result(registry.find(row => row.id === id), outcome, 'TEST', 'Local test evidence');
function calculate(results = [], extra = {}, options = {}) {
  return calculateCoverage({ catalog, registry,
    runs: [{ document: report(results), provenance: 'local-test', ...extra }],
    ...options });
}
const run = value => value.environments[0];
const url = 'https://github.com/owner/repo/actions/runs/123';

test('maintained catalog does not equate registered fixtures with live coverage', () => {
  const value = calculateCoverage();
  assert.equal(value.catalogued, 3);
  assert.equal(value.registeredScenarios, scenarios.length);
  assert.equal(run(value).totals.passed, 0);
  assert.equal(run(value).complete, false);
  assert.equal(run(value).environment, null);
  const onboarding = scenarios.find(row => row.group === 'cli-onboarding');
  const contract = calculateCoverage({ runs: [{
    document: report([result(onboarding, 'passed', 'CONTRACT', 'Synthetic')]),
    provenance: 'local-test', environment: 'contract',
  }] });
  assert.equal(run(contract).totals.passed, 0);
  assert.equal(run(contract).productionPassing, 0);
  assert.equal(run(contract).complete, false);
});
test('denominator is stable for every runner outcome and partial selection', () => {
  for (const outcome of outcomes) {
    for (const results of [[], [observation('a', outcome)],
      [observation('a', outcome), observation('b', outcome)]]) {
      const value = run(calculate(results));
      assert.equal(value.totals.catalogued, 3);
      assert.equal(value.byProduct.Core.catalogued, 1);
      assert.equal(value.byCategory.integration.catalogued, 2);
      assert.equal(value.totals.passed,
        results.length === 2 && outcome === 'passed' ? 1 : 0);
      assert.deepEqual(value, run(calculate([...results].reverse())));
    }
  }
});
test('all required mappings must pass; missing and policy states remain visible', () => {
  for (const outcome of outcomes.filter(value => value !== 'passed')) {
    const value = run(calculate([observation('a'), observation('b', outcome)]));
    assert.equal(value.behaviors.find(row => row.id === 'delivery').outcome, outcome);
    assert.equal(value.totals.passed, 0);
  }
  const value = run(calculate([observation('a')]));
  assert.equal(value.behaviors.find(row => row.id === 'delivery').outcome, 'unverified');
  assert.equal(value.scenarios.filter(row => row.exercised).length, 1);
  assert.equal(value.totals.exercised, 0);
});
test('exercise remains conservative without execution context', () => {
  const results = [observation('a', 'failing'), observation('b', 'unverified')];
  assert.equal(run(calculate(results)).totals.exercised, 0);
  const evidence = registry.map(row => ({
    scenarioId: row.id, urls: [], exercised: true,
  }));
  const value = run(calculate(results, { evidence }));
  assert.equal(value.totals.exercised, 1);
  assert.equal(value.totals.passed, 0);
  assert.throws(() => calculate([observation('a', 'blocked')], {
    evidence: [{ scenarioId: 'a', urls: [], exercised: true }],
  }), /cannot be exercised/);
});
test('run errors retain individual observations and prevent complete claims', () => {
  const errors = ['INVOCATION: private diagnostic <script>'];
  const value = calculate([], {}, { runs: [{
    document: report([observation('a'), observation('b')], errors),
  }] });
  assert.deepEqual(run(value).errors, errors);
  assert.equal(run(value).totals.passed, 1);
  assert.equal(run(value).complete, false);
  assert.doesNotMatch(summarizeCoverage(value), /private diagnostic|<script>/);
  assert.deepEqual(JSON.parse(exportCoverage(value)), value);
});
test('malformed documents, results and ambiguous identities are rejected', () => {
  for (const document of [null, {}, report([observation('a'), observation('a')]),
    report([{ ...observation('a'), id: 'unknown' }]),
    report([{ ...observation('a'), group: 'wrong' }]),
    report([{ ...observation('a'), outcome: 'unknown' }]),
    report([{ ...observation('a'), reason: null }]), report([], [{}])]) {
    assert.throws(() => calculate([], { document }));
  }
  for (const entries of [[catalog[0], catalog[0]],
    [{ ...catalog[0], product: 'Other' }], [{ ...catalog[0], id: '' }],
    [{ ...catalog[0], scenarioIds: ['a', 'a'] }],
    [{ ...catalog[0], scenarioIds: ['Bad ID'] }]]) {
    assert.throws(() => calculate([], {}, { catalog: entries }));
  }
  assert.throws(() => calculate([], {}, { registry: [registry[0], registry[0]] }));
});
test('duplicate associations reject; shared evidence does not inflate totals', () => {
  const results = registry.map(row => observation(row.id));
  const evidence = registry.map(row => ({ scenarioId: row.id, urls: [url, url] }));
  const value = run(calculate(results, { evidence }));
  assert.equal(value.totals.passed, 1);
  assert.equal(value.behaviors.find(row => row.id === 'delivery')
    .scenarios[0].evidenceUrls.length, 1);
  assert.throws(() => calculate(results, { evidence: [evidence[0], evidence[0]] }),
    /Duplicate evidence/);
  assert.throws(() => calculate(results, {
    evidence: [{ scenarioId: 'missing', urls: [url] }],
  }), /Invalid evidence/);
});
test('environments stay separate and local fixtures cannot certify production', () => {
  const value = calculate([], {}, { runs: [
    { environment: 'linux', document: report(registry.map(row => observation(row.id))) },
    { environment: 'windows', document: report([]) },
  ] });
  assert.equal(value.environments[0].totals.passed, 1);
  assert.equal(value.environments[0].productionPassing, 0);
  assert.equal(value.environments[1].totals.passed, 0);
  assert.throws(() => calculate([], {}, { runs: [
    { document: report([]) }, { document: report([]) },
  ] }), /duplicate environment/);
  assert.throws(() => calculate([], { environment: '' }), /Invalid environment/);
  assert.throws(() => calculate([], { provenance: 'success' }), /Invalid provenance/);
});
test('unsafe links cannot promote outcomes or inject summary markup', () => {
  const unsafe = ['javascript:alert(1)', 'http://github.com/o/r/issues/1',
    'https://github.com.evil/o/r/issues/1', 'https://user:secret@github.com/o/r/issues/1',
    'https://evil.test/o/r/issues/1', 'https://github.com/o/r/issues/1?secret=x',
    'https://github.com/o/r/issues/1#<img>', 'https://github.com/o/r/issues/1)bad',
    'https://github.com/o/r/issues/1\n', 'not a URL', null,
    'https://github.com/o/r/issues/1\\bad', 'https://github.com/login'];
  for (const value of unsafe) assert.equal(safeEvidenceUrl(value), null);
  assert.equal(safeEvidenceUrl(url), url);
  assert.equal(safeEvidenceUrl('https://api.github.com/repos/o/r/issues/1'),
    'https://api.github.com/repos/o/r/issues/1');
  const value = calculate([observation('a', 'unverified')], {
    environment: '[click](javascript:alert(1)) <script>\n# bad',
    evidence: [{ scenarioId: 'a', urls: [...unsafe, url] }],
  });
  const summary = summarizeCoverage(value);
  assert.equal(run(value).totals.passed, 0);
  assert.doesNotMatch(summary, /<script>|javascript:|secret|evil\.test/);
  assert.match(summary, /\[GitHub evidence\]/);
  assert.match(summary, /Unsafe evidence links filtered/);
});
test('empty and partial summaries expose unknowns without claiming full coverage', () => {
  const empty = calculate([], {}, { catalog: [], registry: [] });
  assert.equal(run(empty).totals.passedPercent, null);
  const summary = summarizeCoverage(empty);
  assert.match(summary, /0 catalogued; 0 exercised; 0 passed \(unknown\)/);
  assert.match(summary, /Environment: unknown/);
  assert.match(summary, /Complete: no/);
  const partial = summarizeCoverage(calculate([observation('a')]));
  assert.match(partial, /unregistered/);
  assert.match(partial, /Evidence: unknown/);
  assert.match(partial, /No mapped scenarios/);
});

test('native runner empty and invocation errors are retained', async () => {
  const { run: execute } = await import('../runner.mjs');
  const { command } = await import('../cli.mjs');
  for (const document of [await execute([]), await command(['--invalid'])]) {
    const value = calculate([], { document });
    assert.deepEqual(run(value).errors, document.errors);
    assert.equal(run(value).complete, false);
    assert.equal(run(value).totals.passed, 0);
  }
});
test('complete observations remain bounded by explicit context', () => {
  const single = [catalog[0]];
  const results = registry.map(row => observation(row.id));
  const local = run(calculate(results, {}, { catalog: single }));
  assert.equal(local.complete, true);
  assert.equal(local.totals.passedPercent, 100);
  assert.equal(local.productionPassing, 0);
  const native = run(calculate(results, {
    provenance: 'native-observation', environment: 'linux',
  }, { catalog: single }));
  assert.equal(native.productionPassing, 1);
  assert.equal(run(calculate(results, {
    provenance: 'native-observation',
  }, { catalog: single })).productionPassing, 0);
});
