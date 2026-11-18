import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scenarios, select } from '../registry.mjs';
import { execute } from '../execution.mjs';
import { invokeDashboard, verifyNative } from '../scenarios/dashboard/native.mjs';
import { invokeDashboardBrowser } from '../scenarios/dashboard/browser-native.mjs';
import { nativeCases, observationCases, diagnosisCases, browserCases }
  from '../scenarios/dashboard/cases.mjs';
import { verify as verifyBrowser } from '../scenarios/dashboard/browser.mjs';
import { verify as verifyIntegration } from '../scenarios/dashboard/contract.mjs';
import { sourceEnvironment } from '../source-checkout.mjs';

const scratch = fileURLToPath(new URL('../.dashboard-work/', import.meta.url));
async function temporary(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'framework-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const required = [...nativeCases,
  ...observationCases.map(name => `TestE2EDashboardOverview/${name}`),
  ...diagnosisCases.map(name => `TestE2EDashboardDiagnosis/${name}`)];
const output = names => ({ stdout: names.map(Test =>
  JSON.stringify({ Test, Action: 'pass' })).join('\n') });

test('Dashboard registers separate native and browser source requirements', () => {
  const entries = select(scenarios, ['dashboard']);
  assert.deepEqual(entries.map(entry => entry.id),
    ['dashboard.browser', 'dashboard.integration']);
  assert.ok(entries.every(entry => entry.sources.join(',') === 'core,cli'));
  for (const name of ['zero', 'one', 'two', 'four', 'dedup', 'running', 'stage',
    'busy', 'offline', 'queued', 'paused', 'blocked', 'unknown', 'collision', 'stale']) {
    assert.ok(observationCases.includes(name));
  }
  assert.deepEqual(verifyNative(output(required)), required);
});

test('Native failures, skips and absent assertions cannot pass', () => {
  for (const name of required) {
    assert.throws(() => verifyNative(output(required.filter(item => item !== name))));
  }
  for (const Action of ['fail', 'skip']) {
    assert.throws(() => verifyNative({ stdout: output(required).stdout + '\n' +
      JSON.stringify({ Action, Test: required[0] }) }));
  }
  assert.throws(() => verifyNative({ stdout: 'invalid native output' }));
  assert.equal(verifyBrowser({ unavailable: 'No browser installed' }), false);
  assert.equal(verifyIntegration({ unavailable: 'Go toolchain unavailable' }), false);
  assert.throws(() => verifyBrowser({ passed: browserCases.slice(1) }));
});

test('Missing source capabilities block without execution', async t => {
  const tempRoot = await temporary(t);
  for (const entry of select(scenarios, ['dashboard'])) {
    const result = await execute(entry, { tempRoot, sources: {} });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reason.code, 'PREREQUISITE_MISSING');
  }
});

test('Missing maintained browser entry is a bounded missing capability', async t => {
  const root = await temporary(t);
  for (const path of ['core/src/local-work-observation.mjs',
    'core/src/diagnosis-request.mjs', 'core/test/local-work-fixture.mjs',
    'cli/internal/cli/dashboard_diagnosis.go']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), '');
  }
  const result = await execute(select(scenarios, ['dashboard'])[0], {
    tempRoot: root, sources: { core: { checkout: join(root, 'core') },
      cli: { checkout: join(root, 'cli') } },
  });
  assert.equal(result.outcome, 'blocked');
  assert.match(result.reason.message, /maintained browser package/);
});

test('Source and native tool caches stay beneath their owned scratch root', () => {
  const env = sourceEnvironment('/owned/dashboard');
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'HOME', 'GOCACHE', 'GOPATH',
    'npm_config_cache', 'XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH']) {
    assert.ok(env[key] === '/owned/dashboard' ||
      env[key].startsWith('/owned/dashboard/'), key);
  }
});

test('Absent native tools stay unverified instead of passing', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'dashboard/source'), { recursive: true });
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    const actual = await invokeDashboard(root, undefined, { core: { checkout: root } });
    assert.equal(actual.unavailable, 'Go toolchain unavailable');
    assert.equal(verifyIntegration(actual), false);
    const browser = JSON.parse((await invokeDashboardBrowser(root)).stdout);
    assert.equal(browser.unavailable, 'npm unavailable');
    assert.equal(verifyBrowser(browser), false);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test('A different worker module cannot select Dashboard native execution', async t => {
  const root = await temporary(t);
  const module = join(root, 'unauthorized.mjs');
  await writeFile(module, "import {parentPort} from 'node:worker_threads';\n" +
    "export const run = () => new Promise(() => {\n" +
    "parentPort.postMessage({type: 'dashboard-native'}); });\n" +
    'export const verify = () => true;\n');
  const result = await execute({ ...select(scenarios, ['dashboard'])[1],
    module: pathToFileURL(module).href }, { tempRoot: root });
  assert.equal(result.outcome, 'failing');
  assert.equal(result.reason.code, 'INVALID_NATIVE_REQUEST');
});

test('Regression assertion failure propagates through the worker outcome', async t => {
  const root = await temporary(t);
  const module = join(root, 'regression.mjs');
  const contract = new URL('../scenarios/dashboard/contract.mjs', import.meta.url).href;
  await writeFile(module, `export {verify} from ${JSON.stringify(contract)};\n` +
    'export const run = () => ({evidence: "controlled Core/CLI regression",' +
    'passed: []});\n');
  const result = await execute({ ...select(scenarios, ['dashboard'])[1],
    module: pathToFileURL(module).href }, { tempRoot: root });
  assert.equal(result.outcome, 'failing');
  assert.equal(result.reason.code, 'SCENARIO_ERROR');
});
