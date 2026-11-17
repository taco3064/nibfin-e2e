import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSources } from '../sources.mjs';
import { runPrepared } from '../runner.mjs';
import { scenarios, register } from '../registry.mjs';
import { fakeSources } from './source-fixture.mjs';

const fixture = sources => ({
  id: sources.length ? 'dependent' : 'independent', group: 'test',
  title: 'Controlled source selection', timeoutMs: 2000, sources,
  module: new URL('./fixtures/behaviors.mjs?mode=pass', import.meta.url).href,
});

test('declarations are validated, immutable and conservative by default', () => {
  const entry = fixture([]);
  const [registered] = register([entry]);
  entry.sources.push('cli');
  assert.deepEqual(registered.sources, []);
  assert(Object.isFrozen(registered.sources));
  assert.throws(() => register([{ ...entry, sources: ['unknown'] }]));
  const { sources, ...custom } = entry;
  assert.deepEqual(register([custom])[0].sources, ['core', 'action', 'cli']);
});

test('local fixture selections never acquire producers', async () => {
  for (const group of ['wake-contract', 'concurrency-contract']) {
    const document = await runPrepared(scenarios, [group], { sourceOptions: {
      acquire: async () => { throw new Error('must not acquire'); },
    } });
    assert(document.results.every(item => item.outcome === 'passed'));
    assert.deepEqual(document.errors, []);
  }
});

test('Core checkout work avoids builds and unrelated declarations', async () => {
  const fake = fakeSources();
  const set = await prepareSources({ ...fake, requirements: ['core-source'] });
  try {
    assert.deepEqual(fake.requests.map(item => item.id), ['core']);
    assert.deepEqual(fake.prepared, []);
    await assert.rejects(set.preflightRelease('1.2.3'), /partial/);
  } finally { await set.dispose(); }
});

test('CLI closure shares identities without building Action', async () => {
  const fake = fakeSources();
  const set = await prepareSources({ ...fake, requirements: ['cli', 'core-source'] });
  try {
    assert.deepEqual(fake.requests.map(item => item.id), ['core', 'action', 'cli']);
    assert.deepEqual(fake.prepared, ['core', 'cli']);
    assert(set.availability.cli.available);
  } finally { await set.dispose(); }
});

test('settled failures preserve independent results and producer branches', async () => {
  const fake = fakeSources();
  const document = await runPrepared([
    fixture([]), fixture(['cli']),
    { ...fixture(['action']), id: 'action' },
  ], [], { sourceOptions: { ...fake, acquire: async (...args) => {
    if (args[0].id === 'cli') throw new Error('CLI unavailable');
    return fake.acquire(...args);
  } } });
  assert.deepEqual(document.results.map(item => item.outcome),
    ['passed', 'failing', 'passed']);
  assert.match(document.results[1].reason.message, /cli.*CLI unavailable/);
  assert.deepEqual(fake.prepared, ['core', 'action']);
});

test('Core build failure preserves checkout-only work', async () => {
  const fake = fakeSources();
  const document = await runPrepared([
    fixture(['core-source']), { ...fixture(['cli']), id: 'cli' },
  ], [], { sourceOptions: { ...fake, prepare: async () => {
    throw new Error('build failed');
  } } });
  assert.deepEqual(document.results.map(item => item.outcome), ['failing', 'passed']);
});

test('Action incompatibility does not suppress the independently pinned CLI',
  async () => {
  const fake = fakeSources();
  const { put } = await import('./source-fixture.mjs');
  const document = await runPrepared([
    fixture(['action']), { ...fixture(['cli']), id: 'cli' }, fixture([]),
  ], [], { sourceOptions: { ...fake, acquire: async (...args) => {
    const commit = await fake.acquire(...args);
    if (args[0].id === 'action') await put(args[1], 'core-source.json', {});
    return commit;
  } } });
  assert.deepEqual(document.results.map(item => item.outcome),
    ['passed', 'failing', 'passed']);
  assert.match(document.results[1].reason.message, /INCOMPATIBLE_CORE_SOURCE/);
  assert.deepEqual(fake.prepared, ['core', 'cli']);
});

test('unknown selected acquisition stops execution and retains recovery files',
  async () => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tempRoot = await mkdtemp(join(tmpdir(), 'selected-retention-'));
  const fake = fakeSources();
  let removed = false;
  try {
    const document = await runPrepared([fixture([]), fixture(['cli'])], [], {
      sourceOptions: { ...fake, tempRoot, acquire: async (...args) => {
        await fake.acquire(...args);
        throw Object.assign(new Error('unknown acquisition'), {
          terminationUnknown: true,
        });
      }, remove: async () => { removed = true; } },
    });
    assert.deepEqual(document.results, []);
    assert.match(document.errors[0], /SOURCE_TERMINATION_UNKNOWN: retained/);
    assert.equal(fake.requests.length, 1);
    assert.equal(removed, false);
    assert.equal((await readdir(tempRoot)).length, 1);
  } finally {
    // Simulated acquisition starts no process; test recovery can remove its files.
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const inputScenario = (id, sources, expected) => {
  const module = new URL('./fixtures/source-inputs.mjs', import.meta.url);
  module.searchParams.set('expected', JSON.stringify(expected));
  const entry = { ...fixture([]), id, module: module.href };
  if (sources !== undefined) entry.sources = sources;
  else delete entry.sources;
  return entry;
};

test('worker inputs remain stable alone and with other prepared selections', async () => {
  const entries = [
    inputScenario('core-checkout', ['core-source'], { core: false }),
    inputScenario('action-checkout', ['action-source'], { action: false }),
    inputScenario('core-prepared', ['core'], { core: true }),
    inputScenario('action-prepared', ['action'], { core: true, action: true }),
    inputScenario('cli-prepared', ['cli'], { core: true, action: false, cli: true }),
    inputScenario('empty', [], {}),
    inputScenario('default', undefined, { core: true, action: true, cli: true }),
  ];
  for (const selected of [...entries.map(entry => [entry]), entries]) {
    const fake = fakeSources();
    const document = await runPrepared(selected, [], { sourceOptions: fake });
    assert.deepEqual(document.errors, []);
    for (const result of document.results) {
      assert.equal(result.outcome, 'passed', `${result.id}: ${result.reason.message}`);
    }
    assert.equal(document.results.length, selected.length);
    const acquired = fake.requests.map(item => item.id);
    assert.equal(new Set(acquired).size, acquired.length);
    assert.equal(new Set(fake.prepared).size, fake.prepared.length);
    if (selected.length === entries.length) {
      assert.deepEqual(acquired, ['core', 'action', 'cli']);
      assert.deepEqual(fake.prepared, ['core', 'action', 'cli']);
    }
  }
});
