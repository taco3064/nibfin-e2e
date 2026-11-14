import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invokeReleaseProducers } from '../release-producers.mjs';
import { sourceRepositories } from '../source-checkout.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-producer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = Object.fromEntries(sourceRepositories.map(source => [source.id,
    { ...source, commit: 'a'.repeat(40), checkout: join(root, source.id) }]));
  const pin = { repository: sources.core.repository, commit: sources.core.commit,
    archiveHash: 'b'.repeat(64), manifestHash: 'c'.repeat(64) };
  sources.core.output = { pin };
  const files = {
    'core/bin/nibfin-core-release.mjs': '',
    'action/scripts/release.mjs': '',
    'cli/scripts/release/main.go': '',
    'action/core-source.json': JSON.stringify(pin),
    'cli/internal/cli/producers.json': JSON.stringify({ core: pin,
      action: { repository: sources.action.repository, commit: sources.action.commit } }),
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const calls = [];
  const env = { PATH: '/bounded/tools' };
  const context = { root, env, command: async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: 'producer result', stderr: '' };
  } };
  return { root, sources, calls, context, env };
}

test('invokes product interfaces sequentially on the same source set', async t => {
  const f = await fixture(t);
  const result = await invokeReleaseProducers(f.sources, '1.2.3', f.context);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(call => call.options.cwd),
    ['core', 'action', 'cli'].map(id => f.sources[id].checkout));
  assert.ok(f.calls.every(call => call.options.env === f.env));
  assert.deepEqual(f.calls[0].args, [
    join(f.sources.core.checkout, 'bin/nibfin-core-release.mjs'),
    f.sources.core.checkout, '1.2.3', join(f.root, 'release-core'),
  ]);
  assert.deepEqual(f.calls[1].args, [
    join(f.sources.action.checkout, 'scripts/release.mjs'), '1.2.3',
  ]);
  assert.equal(f.calls[2].file, 'go');
  assert.deepEqual(f.calls[2].args,
    ['run', './scripts/release', '--version', '1.2.3']);
  assert.equal(result.coreDirectory, join(f.root, 'release-core'));
  assert.equal(Object.hasOwn(result, 'handoff'), false);
});

for (const path of ['core/bin/nibfin-core-release.mjs',
  'action/scripts/release.mjs', 'cli/scripts/release/main.go']) {
  test(`missing producer prevents all release commands: ${path}`, async t => {
    const f = await fixture(t);
    await rm(join(f.root, path));
    await assert.rejects(invokeReleaseProducers(f.sources, '1.2.3', f.context));
    assert.equal(f.calls.length, 0);
  });
}

for (const phase of [0, 1, 2]) {
  test(`failed producer ${phase} stops without returning partial results`, async t => {
    const f = await fixture(t);
    let calls = 0;
    f.context.command = async () => {
      if (calls++ === phase) throw new Error('build failed');
      return { stdout: '', stderr: '' };
    };
    await assert.rejects(invokeReleaseProducers(f.sources, '1.2.3', f.context),
      /build failed/);
    assert.equal(calls, phase + 1);
  });
}

test('incompatible consumer pins fail before release commands', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sources.action.checkout, 'core-source.json'), '{}');
  await assert.rejects(invokeReleaseProducers(f.sources, '1.2.3', f.context),
    /INCOMPATIBLE_CORE_SOURCE/);
  assert.equal(f.calls.length, 0);
});

test('invalid versions fail before release commands', async t => {
  const f = await fixture(t);
  await assert.rejects(invokeReleaseProducers(f.sources, 'v1.2.3', f.context),
    /VERSION/);
  assert.equal(f.calls.length, 0);
});

for (const path of ['release-core', 'cli/dist']) {
  test(`existing staging cannot be reused: ${path}`, async t => {
    const f = await fixture(t);
    await mkdir(join(f.root, path), { recursive: true });
    await assert.rejects(invokeReleaseProducers(f.sources, '1.2.3', f.context),
      /RELEASE_STAGING_EXISTS/);
    assert.equal(f.calls.length, 0);
  });
}
