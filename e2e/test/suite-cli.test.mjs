import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, readdir, access, symlink }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSimulatedSuite } from '../simulated-suite.mjs';
import { encodeSimulation, decodeSimulation } from '../simulated-codec.mjs';
import { suitePhases } from '../suite-result.mjs';

const cli = new URL('../cli.mjs', import.meta.url);
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'suite-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'unrelated'), 'preserve');
  return root;
}
function invoke(root, phase, resume = false, runId = 'cli-test') {
  const args = ['--suite', '--run-id', runId, '--state-dir', root];
  if (phase) args.push('--phase', phase);
  if (resume) args.push('--resume');
  return execute(args);
}
function execute(args) {
  const result = spawnSync(process.execPath, [cli.pathname, ...args],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  return { status: result.status, document: JSON.parse(lines[0]) };
}
async function manifest(root) {
  return JSON.parse(await readFile(join(root, 'simulated-session.json'), 'utf8'));
}
async function inventoryPath(root) {
  const record = await manifest(root);
  return join(root, record.root, 'inventory', `${record.owner}.json`);
}

test('complete CLI emits controlled fixture outcomes and disposes only its child',
  async t => {
    const root = await directory(t);
    const { status, document } = invoke(root);
    assert.equal(status, 0, JSON.stringify(document));
    assert.equal(document.outcome, 'passed');
    assert.equal(document.cleanup, 'complete');
    assert.equal(document.provenance, 'controlled');
    for (const phase of suitePhases) assert.equal(document.phases[phase].state,
      'passed');
    for (const phase of ['delivery', 'failure']) {
      assert.deepEqual(document.phases[phase].fixtures.map(row => row.id),
        ['ready.mjs', 'ready-b.mjs']);
      assert(document.phases[phase].fixtures.every(row => row.state === 'passed'));
    }
    assert.deepEqual((await readdir(root)).sort(),
      ['simulated-session.json', 'unrelated']);
    const retained = await manifest(root);
    assert(!JSON.stringify(retained).includes('simulation'));
    const again = invoke(root, 'complete', true);
    assert.equal(again.status, 0);
    assert.equal(again.document.sourceOwner, document.sourceOwner);
    assert.deepEqual(again.document.phases, document.phases);
  });

test('fresh CLI processes reconcile original identities without replacement triggers',
  async t => {
    const root = await directory(t);
    let sourceOwner;
    for (const [index, phase] of suitePhases.entries()) {
      const { status, document } = invoke(root, phase, index > 0);
      assert.equal(status, 0, JSON.stringify(document));
      sourceOwner ??= document.sourceOwner;
      assert.equal(document.sourceOwner, sourceOwner);
      assert.equal(document.requested.phase, phase);
      if (phase === 'failure') {
        const inventory = JSON.parse(await readFile(await inventoryPath(root), 'utf8'));
        const state = decodeSimulation(inventory.simulation);
        assert.equal(state.trace.filter(row => row.operation === 'trigger' &&
          row.outcome === 'observed').length, 4);
        for (const record of state.phases.values()) {
          for (const leg of record.legs) {
            assert.equal(state.executions.get(`${leg.binding.repository}/${leg.issue}`),
              leg);
          }
        }
      }
    }
  });

for (const phase of ['install', 'delivery', 'failure']) {
  test(`selected ${phase} does not execute missing prerequisites`, async t => {
    const root = await directory(t);
    const { status, document } = invoke(root, phase);
    assert.equal(status, 1);
    assert.equal(document.phases[phase].state, 'missing-input');
    assert.equal(document.phases.provision.state, 'unobserved');
    const inventory = JSON.parse(await readFile(await inventoryPath(root), 'utf8'));
    assert.equal(decodeSimulation(inventory.simulation).repositories.size, 0);
    assert.equal(invoke(root, 'cleanup', true).status, 0);
  });
}

for (const args of [[], ['--suite'], ['--suite', '--group', 'runner'],
  ['--suite', '--suite'], ['--suite', '--phase', 'unknown'],
  ['--suite', '--run-id', 'bad id'], ['--suite', '--resume', '--resume']]) {
  if (!args.length) continue;
  test(`invalid suite arguments: ${args.join(' ')}`, () => {
    const { status, document } = execute(args);
    assert.equal(status, 1);
    assert.equal(document.kind, 'suite');
    assert.equal(document.reason, 'SUITE_INVALID_REQUEST');
  });
}

test('conflicting identity, repeated creation and missing resume cannot reset state',
  async t => {
    const root = await directory(t);
    assert.equal(invoke(root, 'provision', true).status, 1);
    assert.equal(invoke(root, 'provision').status, 0);
    const before = await readFile(await inventoryPath(root), 'utf8');
    assert.equal(invoke(root, 'install').status, 1);
    assert.equal(invoke(root, 'install', true, 'other').status, 1);
    assert.equal(await readFile(await inventoryPath(root), 'utf8'), before);
    assert.equal(invoke(root, 'cleanup', true).status, 0);
  });

test('session lease covers creation, restoration, execution and checkpoints', async t => {
  const root = await directory(t);
  const session = await createSimulatedSuite({ stateDir: root, runId: 'cli-test' });
  try {
    const result = invoke(root, 'provision');
    assert.equal(result.status, 1);
    assert.equal(result.document.reason, 'SIM_SESSION_OWNERSHIP_UNRESOLVED');
    await session.run({ runId: 'cli-test', phase: 'cleanup', resume: false });
  } finally { await session.close(); }
});

test('killed process leaves a lease; fresh process never replays its old snapshot',
  async t => {
    const root = await directory(t);
    const module = new URL('../simulated-suite.mjs', import.meta.url).href;
    const code = `import { createSimulatedSuite } from ${JSON.stringify(module)};
      const session = await createSimulatedSuite({stateDir:process.argv[1],
        runId:'cli-test'});
      const create = session.provider.create;
      session.provider.create = record => {
        create(record);
        process.stdout.write('committed-before-save');
        return new Promise(() => {});
      };
      setInterval(() => {}, 1000);
      await session.run({runId:'cli-test',phase:'provision',resume:false});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, root],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const before = await readFile(await inventoryPath(root), 'utf8');
      assert.equal(decodeSimulation(JSON.parse(before).simulation).repositories.size, 0);
      const result = invoke(root, 'install', true);
      assert.equal(result.status, 1);
      assert.equal(result.document.reason, 'SIM_SESSION_OWNERSHIP_UNRESOLVED');
      assert.equal(await readFile(await inventoryPath(root), 'utf8'), before);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

for (const change of ['missing-source', 'corrupt', 'foreign-owner', 'executable']) {
  test(`persisted ${change} cannot select capabilities or reset recovery`, async t => {
    const root = await directory(t);
    assert.equal(invoke(root, 'provision').status, 0);
    assert.equal(invoke(root, 'install', true).status, 0);
    assert.equal(invoke(root, 'delivery', true).status, 0);
    const path = await inventoryPath(root);
    const inventory = JSON.parse(await readFile(path, 'utf8'));
    const state = decodeSimulation(inventory.simulation);
    const record = await manifest(root);
    const marker = join(root, 'executed');
    if (change === 'missing-source') {
      await rm(join(root, record.root, 'sources'), { recursive: true });
    } else if (change === 'corrupt') inventory.simulation.version = 99;
    else if (change === 'foreign-owner') state.sourceOwner = 'foreign';
    else {
      const leg = [...state.executions.values()][0];
      leg.merged.content = "import { writeFileSync } from 'node:fs';\n" +
        `writeFileSync(${JSON.stringify(marker)}, 'x');\n`;
    }
    if (change !== 'corrupt') inventory.simulation = encodeSimulation(state);
    await writeFile(path, JSON.stringify(inventory));
    const result = invoke(root, 'delivery', true);
    assert.equal(result.status, 1, JSON.stringify(result));
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'unrelated'), 'utf8'), 'preserve');
  });
}

test('graph representation round trips Maps, Sets, undefined and shared records', () => {
  const record = { value: undefined };
  const state = { map: new Map([['key', record]]), set: new Set([record]), record };
  const decoded = decodeSimulation(JSON.parse(JSON.stringify(encodeSimulation(state))));
  assert.equal(decoded.map.get('key'), decoded.record);
  assert(decoded.set.has(decoded.record));
  assert(Object.hasOwn(decoded.record, 'value'));
  assert.equal(decoded.record.value, undefined);
  assert.throws(() => encodeSimulation({ callback() {} }), /CORRUPT/);
  assert.throws(() => decodeSimulation({ version: 1, root: { ref: 3 }, nodes: [] }),
    /CORRUPT/);
});

test('unknown persisted execution retains original source material', async t => {
  const root = await directory(t);
  assert.equal(invoke(root, 'provision').status, 0);
  const path = await inventoryPath(root);
  const inventory = JSON.parse(await readFile(path, 'utf8'));
  const state = decodeSimulation(inventory.simulation);
  state.active = 1;
  state.effects = 'unknown';
  inventory.simulation = encodeSimulation(state);
  await writeFile(path, JSON.stringify(inventory));
  const result = invoke(root, 'cleanup', true);
  assert.equal(result.status, 1);
  assert.equal(result.document.reason, 'SIM_SESSION_EXECUTION_UNRESOLVED');
  const record = await manifest(root);
  await access(join(root, record.root, 'sources'));
});

test('final report projects bounded fields instead of persisted diagnostics', async t => {
  const root = await directory(t);
  assert.equal(invoke(root).status, 0);
  const record = await manifest(root);
  record.final.phases.delivery.diagnostic = 'secret diagnostic';
  record.final.sources[0].credential = 'secret credential';
  await writeFile(join(root, 'simulated-session.json'), JSON.stringify(record));
  const result = invoke(root, 'complete', true);
  assert.equal(result.status, 0);
  assert(!JSON.stringify(result.document).includes('secret'));
});

test('symlinked recovery inputs cannot redirect restoration or disposal', async t => {
  const root = await directory(t);
  assert.equal(invoke(root, 'provision').status, 0);
  const record = await manifest(root);
  const foreign = join(root, 'unrelated');
  await symlink(foreign, join(root, record.root, 'sources', 'redirect'));
  const result = invoke(root, 'cleanup', true);
  assert.equal(result.status, 1);
  assert.equal(result.document.reason, 'SIM_SESSION_PATH_UNSAFE');
  assert.equal(await readFile(foreign, 'utf8'), 'preserve');
});

for (const option of ['constructor', 'toString', '__proto__', '--unknown']) {
  test(`unknown option ${option} is rejected before session creation`, async t => {
    const root = await directory(t);
    const result = execute(['--suite', '--run-id', 'cli-test', '--state-dir', root,
      option, 'value']);
    assert.equal(result.status, 1);
    assert.equal(result.document.reason, 'SUITE_INVALID_REQUEST');
    assert.deepEqual(await readdir(root), ['unrelated']);
  });
}

test('durable handles preserve selected runs and restart without losing the lease',
  async t => {
    const root = await directory(t);
    let session = await createSimulatedSuite({ stateDir: root, runId: 'cli-test' });
    try {
      const first = session.run({ runId: 'cli-test', phase: 'provision' });
      await assert.rejects(session.close(), /SIM_SUITE_UNAVAILABLE/);
      assert.equal((await first).phases.provision.state, 'passed');
      const sourceOwner = session.prepared.ownershipId;
      const install = await session.run({ runId: 'cli-test', phase: 'install',
        resume: true });
      assert.equal(install.phases.install.state, 'passed');
      const previous = session;
      session = await session.restart();
      await assert.rejects(previous.run({ runId: 'cli-test', phase: 'delivery',
        resume: true }), /SIM_SESSION_BINDING_CONFLICT/);
      assert.equal(session.prepared.ownershipId, sourceOwner);
      const result = await session.run({ runId: 'cli-test', resume: true });
      assert.equal(result.outcome, 'passed');
      await session.dispose();
    } finally { await session.close(); }
  });

test('failed checkpoint after a committed effect retains the session lease', async t => {
  const root = await directory(t);
  const session = await createSimulatedSuite({ stateDir: root, runId: 'cli-test' });
  const snapshot = session.provider.snapshot;
  session.provider.snapshot = () => {
    if (session.provider.repositories.size) throw new Error('SIM_TEST_SAVE_FAILED');
    return snapshot();
  };
  try {
    await assert.rejects(session.run({ runId: 'cli-test', phase: 'provision' }),
      /SIM_TEST_SAVE_FAILED/);
    assert.equal(session.provider.settled, true);
    assert.equal(session.provider.repositories.size, 1);
    await session.close();
    const result = invoke(root, 'provision', true);
    assert.equal(result.status, 1);
    assert.equal(result.document.reason, 'SIM_SESSION_OWNERSHIP_UNRESOLVED');
  } finally {
    session.provider.snapshot = snapshot;
    await session.close();
  }
});
