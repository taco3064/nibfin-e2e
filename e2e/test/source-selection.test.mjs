import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../cli.mjs';
import { groupArguments, sourceSelection } from '../source-selection.mjs';
import { acquireSource, sourceRepositories } from '../source-checkout.mjs';
import { prepareSources } from '../sources.mjs';
import { runPrepared } from '../runner.mjs';
import { commits, fakeSources, pin, put } from './source-fixture.mjs';

const scenario = (id, sources) => ({
  id, sources, group: 'historical', title: 'Controlled historical sources',
  timeoutMs: 2000,
  module: new URL('./fixtures/behaviors.mjs?mode=pass', import.meta.url).href,
});

test('ordinary arguments share strict library selection normalization', async () => {
  const parsed = groupArguments(['--source', `core=${commits.core}`,
    '--group', 'one', '--source', 'cli=refs/tags/v1', '--group', 'two']);
  assert.deepEqual(parsed, { groups: ['one', 'two'], selection: {
    core: commits.core, cli: 'refs/tags/v1',
  } });
  assert.deepEqual(sourceSelection(), {});
  for (const value of ['core', 'unknown=main', 'core=', 'core=HEAD~1',
    'core=--upload-pack=bad', 'cli=https://github.com/other/repo',
    'cli=/tmp/source', 'core=refs/heads/a..b', 'core=refs/tags/a.lock',
    'core=refs/heads/a//b', 'core=refs/heads/a/.b', 'core=abc123']) {
    assert.throws(() => groupArguments(['--source', value]), value);
    const document = await command(['--source', value]);
    assert.equal(document.results.length, 0);
    assert.match(document.errors[0], /INVOCATION_OR_RUNNER_ERROR/);
  }
  assert.throws(() => groupArguments(['--source', 'core=main',
    '--source', 'core=main']), /DUPLICATE_SOURCE/);
  for (const selection of [null, [], { unknown: 'main' }, { core: 'HEAD^' }]) {
    let acquired = false;
    await assert.rejects(prepareSources({ selection, acquire: async () => {
      acquired = true;
    } }));
    assert.equal(acquired, false);
  }
});

for (const revision of [commits.core, 'refs/tags/v1', 'refs/heads/history']) {
  test(`explicit ${revision} fetches once and checks out the observed commit`,
    async () => {
    const calls = [];
    const source = { ...sourceRepositories[0], revision };
    const commit = await acquireSource(source, '/owned/core', {
      root: '/owned', env: {}, command: async (file, args) => {
        calls.push(args);
        return { stdout: `${commits.core}\n` };
      },
    });
    assert.equal(commit, commits.core);
    assert.deepEqual(calls[1], ['-C', '/owned/core', 'remote', 'add',
      'origin', source.url]);
    assert.deepEqual(calls[2], ['-C', '/owned/core', 'fetch', '--depth=1',
      '--no-tags', '--', 'origin', revision]);
    assert.deepEqual(calls[3], ['-C', '/owned/core', 'rev-parse', '--verify',
      'FETCH_HEAD^{commit}']);
    assert.deepEqual(calls[4], ['-C', '/owned/core', 'checkout', '-B', 'main',
      commits.core]);
    assert.equal(calls.length, 5);
  });
}

test('explicit failures cannot silently fall back or execute a wrong commit',
  async () => {
  for (const mode of ['unavailable', 'wrong-commit']) {
    const calls = [];
    await assert.rejects(acquireSource({ ...sourceRepositories[1],
      revision: commits.action }, '/owned/action', {
      root: '/owned', env: {}, command: async (file, args) => {
        calls.push(args);
        if (mode === 'unavailable' && args.includes('fetch')) {
          throw new Error('unavailable');
        }
        return { stdout: `${commits.core}\n` };
      },
    }), mode === 'unavailable' ? /unavailable/ : /REQUESTED_COMMIT_MISMATCH/);
    assert.equal(calls.some(args => args.includes('checkout')), false);
    assert.equal(calls.filter(args => args.includes('fetch')).length, 1);
  }
});

test('historical selections retain exact compatibility and independent progress',
  async () => {
  for (const explicit of [false, true]) {
    for (const compatible of [false, true]) {
      const tempRoot = await mkdtemp(join(tmpdir(), 'source-selection-'));
      try {
        const fake = fakeSources();
        const selection = explicit ? { ...commits } : {};
        const document = await runPrepared([
          scenario('dependent', ['cli']), scenario('independent', []),
        ], [], { sourceOptions: { ...fake, tempRoot, selection,
          acquire: async (...args) => {
            const commit = await fake.acquire(...args);
            if (!compatible && args[0].id === 'cli') {
              await put(args[1], 'internal/cli/producers.json', {
                core: { ...pin, commit: 'f'.repeat(40) },
                action: { repository: 'taco3064/nibfin-act', commit: commits.action },
              });
            }
            return commit;
          },
        } });
        assert.deepEqual(document.results.map(item => item.outcome),
          [compatible ? 'passed' : 'failing', 'passed']);
        if (!compatible) {
          assert.match(document.results[0].reason.message, /INCOMPATIBLE_CORE_SOURCE/);
        }
        assert.deepEqual(document.sources, fake.requests.map(source => ({
          id: source.id, repository: source.repository,
          revision: selection[source.id] ?? 'main', commit: commits[source.id],
        })));
        assert(!JSON.stringify(document.sources).includes(tempRoot));
        assert.deepEqual(await readdir(tempRoot), []);
      } finally { await rm(tempRoot, { recursive: true, force: true }); }
    }
  }
});

test('selection does not expand source-free or checkout-only requirements', async () => {
  const fake = fakeSources();
  const document = await runPrepared([scenario('core', ['core-source'])], [], {
    sourceOptions: { ...fake, selection: { cli: commits.cli } },
  });
  assert.deepEqual(fake.requests.map(source => source.id), ['core']);
  assert.deepEqual(fake.prepared, []);
  assert.deepEqual(document.sources.map(source => source.id), ['core']);
  const empty = await runPrepared([scenario('empty', [])], [], {
    sourceOptions: { ...fake, acquire: async () => assert.fail('unexpected source') },
  });
  assert.deepEqual(empty.sources, []);
});

// Exercise the real producer preparation implementation; only external commands
// and public acquisition are simulated. No producer implementation is replaced.
test('selected sources reach production preparation before scenario execution',
  async () => {
  const fake = fakeSources();
  const calls = [];
  const document = await runPrepared([scenario('built', ['action'])], [], {
    sourceOptions: { acquire: fake.acquire, selection: {
      core: commits.core, action: commits.action,
    },
      command: async (file, args, { cwd }) => {
        calls.push(args);
        if (args[0] === 'scripts/package-ci.mjs') {
          await put(cwd, 'distribution/source-pin.json', pin);
          await put(cwd, 'distribution/nibfin-core.tar.gz', 'controlled archive');
          return { stdout: JSON.stringify({ ...pin, status: 'verified-build' }) };
        }
        if (file === 'npm') return { stdout: '' };
        assert.equal(args[0], '--input-type=module');
        return { stdout: JSON.stringify({
          using: `node${process.versions.node.split('.')[0]}`, main: 'src/main.mjs',
        }) };
      },
    },
  });
  assert.equal(document.results[0].outcome, 'passed');
  assert.deepEqual(document.errors, []);
  assert.equal(calls.length, 4);
  assert.equal(document.sources[0].commit, commits.core);
  await assert.rejects(access(fake.requests[0].checkout));
});

test('partial acquisition and cleanup failures preserve only observed identities',
  async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'source-identity-failure-'));
  try {
    const fake = fakeSources();
    const document = await runPrepared([scenario('partial', ['cli'])], [], {
      sourceOptions: { ...fake, tempRoot, acquire: async (...args) => {
        if (args[0].id === 'cli') throw new Error('revision unavailable');
        return fake.acquire(...args);
      }, remove: async () => { throw new Error('controlled cleanup failure'); } },
    });
    assert.equal(document.results[0].outcome, 'failing');
    assert.match(document.errors[0], /SOURCE_CLEANUP_ERROR/);
    assert.deepEqual(document.sources.map(source => source.id), ['core', 'action']);
    assert.equal((await readdir(tempRoot)).length, 1);
  } finally {
    // Controlled fixtures started no subprocess; their retained files are disposable.
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('invalid direct acquisition rejects before any command', async () => {
  await assert.rejects(acquireSource({ ...sourceRepositories[0],
    revision: 'main^{tree}' }, '/owned/core', {
    root: '/owned', env: {}, command: async () => assert.fail('unexpected command'),
  }), /INVALID_SOURCE_REVISION/);
});
