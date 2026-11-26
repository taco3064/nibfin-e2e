import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import type { MapEntry, ProvisioningStep, Scenario } from '../src/types.ts';
import { fakeHostContext, map, passed, scenario, scenarioA, scenarioB, scenarios, step } from './fixtures.ts';

const commit = ['--gh-nibfin-commit', 'c'.repeat(40)];

async function cli(argv: string[], opts: { entries?: MapEntry[]; scenarios?: Scenario[]; steps?: ProvisioningStep[]; errors?: string[]; nodePlatform?: string } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    loadMap: () => ({ entries: opts.entries ?? map, errors: opts.errors ?? [] }),
    scenarios: opts.scenarios ?? scenarios,
    steps: opts.steps ?? [],
    host: fakeHostContext,
    nodePlatform: opts.nodePlatform ?? 'linux',
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
  });
  return { code, json: JSON.parse(stdout), stderr };
}

test('usage errors exit 2 with one JSON document', async () => {
  const cases: [string[], RegExp][] = [
    [['--bogus'], /Unknown option/],
    [['--all', '--rule', 'R3.1', '--list'], /either --all or/],
    [['--list', '--uncovered'], /either --list or --uncovered/],
    [['--list', ...commit], /only for execution/],
    [[...commit], /needs --all or/],
    [['--all'], /--gh-nibfin-commit must be/],
    [['--all', '--gh-nibfin-commit', 'main'], /--gh-nibfin-commit must be/],
    [['--all', ...commit, '--image', 'ghcr.io/x@sha256:' + 'd'.repeat(64)], /Unknown option '--image'/],
    [['--list', '--rule', 'R9.9'], /not in the coverage map/],
    [['--list', '--section', '7'], /no rules/],
  ];
  for (const [argv, expected] of cases) {
    const r = await cli(argv);
    equal(r.code, 2, argv.join(' '));
    equal(r.json.error.kind, 'usage');
    match(r.json.error.messages.join('\n'), expected);
  }
  match((await cli(['--all', ...commit], { nodePlatform: 'aix' })).json.error.messages[0], /unsupported platform/);
});

test('validation errors exit 2 in every mode', async () => {
  const broken = { scenarios: [scenario('x', ['R5.14'], ['macos'], passed)] };
  for (const argv of [['--list'], ['--uncovered'], ['--all', ...commit]]) {
    const r = await cli(argv, broken);
    equal(r.code, 2);
    equal(r.json.error.kind, 'validation');
  }
  equal((await cli(['--list'], { errors: ['coverage map: bad'] })).json.error.messages[0], 'coverage map: bad');
});

test('--list and --uncovered report without running', async () => {
  let ran = false;
  const spy = [{ ...scenarioA, run: async () => ((ran = true), passed) }, scenarioB];
  const list = await cli(['--list', '--section', '0', '--rule', 'R3.1'], { scenarios: spy });
  equal(list.code, 0);
  deepEqual(list.json.rules, ['R3.1']);
  deepEqual(list.json.excluded, [{ id: 'R0.1', reason: '文件定位' }]);
  deepEqual(list.json.scenarios.map((s: { id: string }) => s.id), ['a']);
  const unc = await cli(['--uncovered'], { scenarios: spy });
  equal(unc.code, 0);
  deepEqual(unc.json.selection, { all: true });
  deepEqual(unc.json.coverage.uncovered, [{ id: 'R5.14', missingPlatforms: ['macos'] }]);
  equal(ran, false);
});

test('execution exits 0 when selected scenarios pass and 1 when the gate fails', async () => {
  const sel = await cli(['--rule', 'R3.1', ...commit]);
  equal(sel.code, 0);
  deepEqual(sel.json.scenarios.map((s: { id: string; status: string }) => [s.id, s.status]), [['a', 'passed']]);
  equal(sel.json.meta.imageDigest, null);
  equal(sel.json.meta.ghNibfinCommit, 'c'.repeat(40));
  deepEqual(sel.json.teardown, []);
  equal(sel.json.meta.platform, 'linux');
  const all = await cli(['--all', ...commit]);
  equal(all.code, 1);
  equal(all.json.gate.passed, false);
});

test('execution exits 1 when a scenario fails', async () => {
  const failing = [scenario('a', ['R3.1', 'R3.2'], ['linux'], new Error('nope')), scenarioB];
  const r = await cli(['--rule', 'R3.1', ...commit], { scenarios: failing });
  equal(r.code, 1);
  equal(r.json.scenarios[0].reason, 'nope');
});

test('execution exits 1 when a teardown fails, even if every scenario passed', async () => {
  const steps = [step('host', passed, undefined, { teardown: async () => ({ status: 'failed', reason: 'Issues left' }) })];
  const withStep = [scenario('a', ['R3.1', 'R3.2'], ['linux'], passed, ['host']), scenarioB];
  const r = await cli(['--rule', 'R3.1', ...commit], { scenarios: withStep, steps });
  equal(r.code, 1);
  deepEqual(r.json.scenarios.map((s: { status: string }) => s.status), ['passed']);
  deepEqual(r.json.teardown, [{ id: 'host', status: 'failed', reason: 'Issues left' }]);
});
