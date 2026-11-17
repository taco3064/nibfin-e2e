import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile }
  from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { executeNative, nativeCases, requiredManagedCases }
  from '../scenarios/cli-onboarding/native.mjs';
import { managedCases } from '../scenarios/cli-onboarding/native-command.mjs';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { verify } from '../scenarios/cli-onboarding/contract.mjs';
import { continuityCases } from '../scenarios/cli-onboarding/continuity.mjs';
import { deliveryCases } from '../scenarios/cli-onboarding/delivery-continuity.mjs';

const passed = () => [...nativeCases.flatMap(name => ['', '/User', '/Organization']
  .map(suffix => name + suffix)), ...requiredManagedCases];
const events = names => names.map(Test => ({ Action: 'pass', Test }));
const output = rows => ({ stdout: rows.map(row => JSON.stringify(row)).join('\n') });

async function fixture(t) {
  const tempDir = await mkdtemp(join(tmpdir(), 'managed-harness-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  // Cover the supplied upstream checkout basename as well as prepared "cli".
  const checkout = join(tempDir, 'gh-nibfin');
  await mkdir(join(checkout, 'internal/cli'), { recursive: true });
  await writeFile(join(checkout, 'go.mod'), 'fixture module\n');
  const context = { tempDir, sources: { cli: { checkout } } };
  return { context, checkout, root: join(tempDir, 'cli-contract'), tempDir };
}

test('managed integration copies Linux drivers and binds exclusive owned A/B state',
  async t => {
    const f = await fixture(t);
    const observed = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await executeNative(f.context, async () => {
        assert.equal(await readFile(join(f.root, 'source/go.mod'), 'utf8'),
          'fixture module\n');
        for (const name of ['fixture', 'host', 'readback', 'resume']) {
          const source = await readFile(join(f.root, 'source/internal/cli',
            `e2e_managed-${name}_linux_test.go`), 'utf8');
          assert.match(source, /^\/\/go:build linux/);
        }
        const binding = JSON.parse(await readFile(join(f.root,
          'home/managed-fixture.json'), 'utf8'));
        assert.match(binding.hostId, /^simulation-/);
        assert.equal(binding.repositories.length, 2);
        assert.notEqual(...binding.repositories);
        assert(binding.repositories.every(repo => repo.startsWith('e2e-managed/')));
        const directory = join(f.root, 'inventory');
        const statePath = join(directory, `${binding.owner}.json`);
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        assert.equal(state.simulation.execution, 'pending');
        assert.equal(state.simulation.hostId, binding.hostId);
        assert.deepEqual(state.definition.repositories, binding.repositories);
        const competing = await fixtureInventory(directory, state.definition,
          state.actor, join(f.root, 'source'));
        await assert.rejects(competing.exclusive(() => assert.fail('stolen lock')),
          { code: 'EEXIST' });
        observed.push(binding);
        return output(events(passed()));
      });
      assert.equal(result.evidence, 'synthetic');
      assert.deepEqual(await readdir(f.tempDir), ['gh-nibfin']);
      assert.deepEqual(await readdir(join(f.checkout, 'internal/cli')), []);
    }
    assert.notEqual(observed[0].owner, observed[1].owner);
    assert.notEqual(observed[0].hostId, observed[1].hostId);
    assert.notDeepEqual(observed[0].repositories, observed[1].repositories);
  });

test('each managed case is mandatory; fail and skip cannot hide behind passes',
  async t => {
  const f = await fixture(t);
  for (const name of requiredManagedCases) {
    await assert.rejects(executeNative(f.context, async () =>
      output(events(passed().filter(value => value !== name)))),
    new RegExp(`NATIVE_ASSERTIONS_MISSING: ${name}`));
    for (const Action of ['fail', 'skip']) {
      await assert.rejects(executeNative(f.context, async () =>
        output([...events(passed()), { Action, Test: name }])),
      /NATIVE_ASSERTIONS_INCOMPLETE/);
    }
  }
  assert.deepEqual(await readdir(f.tempDir), ['gh-nibfin']);
  const actual = { evidence: 'synthetic', passed: passed(),
    continuity: { evidence: 'synthetic', passed: [...continuityCases] },
    delivery: { evidence: 'synthetic', passed: [...deliveryCases] } };
  assert.equal(verify(actual), true);
  if (process.platform === 'linux') {
    for (const name of managedCases) {
      assert.throws(() => verify({ ...actual,
        passed: actual.passed.filter(value => value !== name) }));
    }
  } else assert.deepEqual(requiredManagedCases, []);
});

test('unknown native termination preserves checkout and exclusive recovery inventory',
  async t => {
    const f = await fixture(t);
    const error = Object.assign(new Error('synthetic unresolved termination'), {
      terminationUnknown: true, stdout: 'diagnostic',
    });
    await assert.rejects(executeNative(f.context, async () => { throw error; }),
      value => value === error);
    assert.equal(await readFile(join(f.root, 'source/go.mod'), 'utf8'),
      'fixture module\n');
    const binding = JSON.parse(await readFile(join(f.root,
      'home/managed-fixture.json'), 'utf8'));
    const inventory = join(f.root, 'inventory');
    assert((await readdir(inventory)).includes(`${binding.owner}.json.lock`));
    // This injected command never spawned anything. The test owns its teardown.
    await rm(f.root, { recursive: true, force: true });
    await assert.rejects(executeNative(f.context, async () => {
      throw new Error('settled failure');
    }), /settled failure/);
    assert.deepEqual(await readdir(f.tempDir), ['gh-nibfin']);
  });


test('parent retains native worker storage when group termination is unknown',
  async t => {
    const f = await fixture(t);
    const workers = join(f.tempDir, 'workers');
    await mkdir(workers);
    const execution = new URL('../execution.mjs', import.meta.url).href;
    const module = new URL('../scenarios/cli-onboarding/contract.mjs',
      import.meta.url).href;
    const sources = { ...f.context.sources, core: { checkout: 'synthetic' },
      action: { checkout: 'synthetic' } };
    sources.cli.output = { entry: 'synthetic' };
    const script = [
      "import childProcess from 'node:child_process';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const originalSpawn = childProcess.spawn;',
      'childProcess.spawn = (file, args, options) => file === \'go\' ?',
      // The simulated producer exits naturally and never has descendants.
      "  originalSpawn(process.execPath, ['-e', 'process.exit(0)'], options) :",
      '  originalSpawn(file, args, options);',
      'syncBuiltinESMExports();',
      'const originalKill = process.kill;',
      'process.kill = (pid, signal) => {',
      '  if (pid < 0) throw Object.assign(new Error(\'signal denied\'),',
      "    { code: 'EPERM' });",
      '  return originalKill(pid, signal);',
      '};',
      `const { execute } = await import(${JSON.stringify(execution)});`,
      `const scenario = { id: 'managed', group: 'local', title: 'Synthetic',`,
      `  timeoutMs: 10000, module: ${JSON.stringify(module)} };`,
      'console.log(JSON.stringify(await execute(scenario, {',
      `  sources: ${JSON.stringify(sources)},`,
      `  tempRoot: ${JSON.stringify(workers)}`,
      '})));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.reason.code, 'TERMINATION_ERROR');
    const remaining = await readdir(workers);
    assert.equal(remaining.length, 1);
    const root = join(workers, remaining[0], 'cli-contract');
    assert.equal(await readFile(join(root, 'source/go.mod'), 'utf8'),
      'fixture module\n');
    assert((await readdir(join(root, 'inventory'))).some(path =>
      path.endsWith('.json.lock')));
    // Termination uncertainty was injected after natural exit; no process remains.
  });
