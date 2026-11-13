import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { register, select } from '../registry.mjs';
import { run } from '../runner.mjs';
import { command } from '../cli.mjs';
import { exitCode } from '../schema.mjs';

function scenario(mode = 'pass', overrides = {}) {
  const module = new URL('./fixtures/behaviors.mjs', import.meta.url);
  module.searchParams.set('mode', mode);
  return {
    id: mode, group: 'local', title: `Synthetic ${mode}`,
    timeoutMs: 2000, module: module.href, ...overrides,
  };
}
async function isolated(check) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-test-'));
  try { await check(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('selection is ordered, deduplicated and rejects unknown groups', () => {
  const entries = [scenario('z'), scenario('a', { group: 'other' })];
  assert.deepEqual(select(entries).map(item => item.id), ['a', 'z']);
  assert.deepEqual(select(entries.reverse()).map(item => item.id), ['a', 'z']);
  assert.deepEqual(select(entries, ['local', 'local']).map(item => item.id), ['z']);
  assert.throws(() => select(entries, ['unknown']), /Unknown group/);
  assert.throws(() => register([scenario(), scenario()]), /Duplicate/);
});
test('metadata rejects malformed fields and unknown properties', () => {
  for (const change of [
    { id: '' }, { group: 'bad group' }, { title: '' }, { timeoutMs: 0 },
    { timeoutMs: Infinity }, { timeoutMs: 0.5 }, { module: 'https://invalid' },
    { policyReason: '' }, { extra: true }, { module: 'relative.mjs' },
    { toString: 'invalid inherited field' },
  ]) assert.throws(() => register([scenario('pass', change)]));
});
test('success requires execution and assertions, with isolated cleanup', async () => {
  await isolated(async tempRoot => {
    const dirs = [];
    const document = await run([scenario('pass'), scenario('timer')], [], {
      tempRoot,
      remove: async (path, options) => {
        dirs.push(path);
        assert.deepEqual(await readdir(path), ['owned.txt']);
        await rm(path, options);
      },
    });
    assert.equal(document.schemaVersion, 1);
    assert.deepEqual(document.results.map(item => item.outcome), ['passed', 'passed']);
    assert.equal(new Set(dirs).size, 2);
    assert.deepEqual(await readdir(tempRoot), []);
    assert.equal(exitCode(document), 0);
  });
});
for (const mode of ['throw', 'reject', 'assert', 'timeout', 'busy', 'assert-timeout']) {
  test(`${mode} cannot pass and cleans up after execution settles`, async () => {
    await isolated(async tempRoot => {
      const timed = ['timeout', 'busy', 'assert-timeout'].includes(mode);
      const document = await run([
        scenario(mode, { timeoutMs: timed ? 150 : 2000 }),
      ], [], { tempRoot });
      assert.equal(document.results[0].outcome, 'failing');
      assert.equal(document.results[0].reason.code,
        timed ? 'TIMEOUT' : 'SCENARIO_ERROR');
      assert.equal(exitCode(document), 1);
      assert.deepEqual(await readdir(tempRoot), []);
    });
  });
}
test('policy, prerequisites and incomplete verification stay distinct', async () => {
  const unsupported = new URL('./fixtures/unsupported.mjs', import.meta.url).href;
  const document = await run([
    scenario('policy', { policyReason: 'Excluded locally', module: unsupported }),
    scenario('blocked'), scenario('unverified'),
    scenario('unsupported', { module: unsupported }), scenario('exit'),
  ]);
  const statuses = Object.fromEntries(document.results.map(item =>
    [item.id, item.outcome]));
  assert.deepEqual(statuses, {
    blocked: 'blocked', exit: 'unverified', policy: 'skipped-by-policy',
    unsupported: 'unverified', unverified: 'unverified',
  });
  assert.equal(exitCode(document), 1);
  assert.equal(exitCode(await run([scenario('policy', {
    policyReason: 'Excluded locally',
  })])), 0);
});
test('cleanup and setup failures remain visible', async () => {
  await isolated(async tempRoot => {
    const document = await run([scenario()], [], {
      tempRoot, remove: async () => { throw new Error('synthetic cleanup failure'); },
    });
    assert.equal(document.results[0].reason.code, 'CLEANUP_ERROR');
    assert.equal(exitCode(document), 1);
    assert.equal((await readdir(tempRoot)).length, 1);
  });
  const document = await run([scenario()], [], { tempRoot: '/missing/nibfin' });
  assert.equal(document.results[0].reason.code, 'INFRASTRUCTURE_ERROR');
});
test('module errors and empty registry never imply success', async () => {
  const missing = new URL('./fixtures/missing.mjs', import.meta.url).href;
  assert.equal((await run([scenario('missing', { module: missing })]))
    .results[0].outcome, 'failing');
  assert.equal(exitCode(await run([])), 1);
});
test('CLI rejects invalid arguments and fails truthfully', async () => {
  for (const args of [['--group'], ['--all'], ['--group', 'unknown']]) {
    assert.equal(exitCode(await command(args, [scenario()])), 1);
  }
  assert.equal(exitCode(await command(['--group', 'local'], [scenario()])), 0);
  const child = spawnSync(process.execPath, ['e2e/cli.mjs'], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).schemaVersion, 1);
});
test('worker diagnostics cannot corrupt JSON output', () => {
  const source = [
    "import { command } from './e2e/cli.mjs';",
    "import { exitCode } from './e2e/schema.mjs';",
    `const entries = ${JSON.stringify([scenario('throw')])};`,
    'const document = await command([], entries);',
    'console.log(JSON.stringify(document));',
    'process.exitCode = exitCode(document);',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).results[0].outcome, 'failing');
  assert.match(child.stderr, /fixture diagnostics/);
});

test('late completion cannot recreate directories or overwrite timeout', async () => {
  await isolated(async tempRoot => {
    const document = await run([scenario('timeout', { timeoutMs: 150 })], [], {
      tempRoot,
    });
    const original = JSON.stringify(document);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(JSON.stringify(document), original);
    assert.equal(document.results[0].reason.code, 'TIMEOUT');
    assert.deepEqual(await readdir(tempRoot), []);
  });
});
