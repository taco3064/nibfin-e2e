import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareRelease } from '../release-preflight.mjs';
import { createContractGate } from '../release-gate.mjs';
import { report, result } from '../schema.mjs';
import { releaseFixture } from './release-fixture.mjs';

async function fixture(t, failure) {
  const f = await releaseFixture(t);
  await rm(f.staged.coreDirectory, { recursive: true });
  await rm(join(f.sources.cli.checkout, 'dist'), { recursive: true });
  for (const path of ['core/bin/nibfin-core-release.mjs',
    'action/scripts/release.mjs', 'cli/scripts/release/main.go']) await f.put(path, '');
  let ran = false;
  let builds = 0;
  const prepared = { sources: f.sources, disposed: false,
    async preflightRelease(version) {
      assert.equal(ran, true);
      await prepareRelease(f.sources, version, f.context);
    },
    async dispose() {
      await rm(f.root, { recursive: true, force: true });
      this.disposed = true;
    } };
  f.context.command = async (file, args) => {
    if (file === 'git') return { stdout: args.includes('rev-parse') ?
      f.sources.core.commit : '', stderr: '' };
    if (!args.includes('--input-type=module')) {
      builds++;
      assert.equal(prepared.disposed, false);
      if (failure === 'build') throw new Error('build failed');
      if (file === 'go' && failure === 'unknown') {
        throw Object.assign(new Error('unsettled producer'), {
          terminationUnknown: true,
        });
      }
      const prefix = file === 'go' ? 'cli/dist/' : builds === 1 ?
        'release-core/' : 'action/package';
      for (const [path, value] of Object.entries(f.files)) {
        if (path.startsWith(prefix) &&
            !(failure === 'partial' && path.endsWith('gh-nibfin_windows_arm64.exe'))) {
          await f.put(path, value);
        }
      }
      if (builds === 1) return f.staged.core;
      if (builds === 2) return f.staged.action;
      return { stdout: '', stderr: '' };
    }
    return { stdout: JSON.stringify(f.metadata), stderr: '' };
  };
  if (failure === 'missing') await rm(join(f.sources.cli.checkout,
    'scripts/release/main.go'));
  const expected = { repository: 'taco3064/nibfin-e2e', workflow: 'release.yml',
    environment: 'release' };
  const capabilities = { expected,
    verifyInvocation: async () => ({ ...expected, authorized: true,
      actor: 'operator', runId: '1', attempt: '1', event: 'workflow_dispatch',
      ref: 'refs/heads/main' }),
    observeConflicts: async version => Object.values(f.sources).map(source => ({
      repository: source.repository, version, complete: true, tags: [],
      releases: [], activePublications: [],
    })),
    observeMains: async () => Object.values(f.sources).map(source => ({
      repository: source.repository, ref: source.ref, commit: source.commit,
      complete: true,
    })),
  };
  const registry = ['Core', 'Action', 'CLI'].map(product => ({
    id: product.toLowerCase(), group: 'release', title: product, timeoutMs: 1000,
    module: new URL('./fixtures/release.mjs', import.meta.url).href,
  }));
  const catalog = registry.map(row => ({ id: row.id, product: row.title,
    category: 'release', scenarioIds: [row.id] }));
  const gate = createContractGate(capabilities, { catalog, registry,
    prepare: async () => prepared,
    run: async selected => {
      ran = true;
      return report(selected.map(row => result(row, 'passed', 'PASS', 'executed')));
    } });
  return { invoke: () => gate(['1.2.3']), prepared, builds: () => builds };
}

test('gate runs producers and complete staging validation before cleanup', async t => {
  const f = await fixture(t);
  const actual = await f.invoke();
  assert.equal(actual.outcome, 'ready', actual.reason);
  assert.equal(f.builds(), 3);
  assert.equal(f.prepared.disposed, true);
});
for (const failure of ['missing', 'build', 'partial', 'unknown']) {
  test(`integrated ${failure} failure never exposes a partial handoff`, async t => {
    const f = await fixture(t, failure);
    const actual = await f.invoke();
    assert.equal(actual.outcome, 'blocked');
    assert.equal(Object.hasOwn(actual, 'handoff'), false);
    assert.match(actual.reason, /ENOENT|build failed|unsettled producer/);
    assert.equal(f.prepared.disposed, failure !== 'unknown');
    if (failure === 'missing') assert.equal(f.builds(), 0);
    // The unknown fixture starts no processes; t.after safely removes its files.
  });
}
