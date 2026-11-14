import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareSources, withPreparedSources } from '../sources.mjs';
import { sourceRepositories, acquireSource } from '../source-checkout.mjs';
import { run, runPrepared } from '../runner.mjs';
import { exitCode } from '../schema.mjs';
import { commits, fakeSources, pin, put } from './source-fixture.mjs';

async function isolated(check) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'nibfin-source-test-'));
  try { await check(tempRoot); }
  finally { await rm(tempRoot, { recursive: true, force: true }); }
}

test('official mains are acquired once, retained, and resolved afresh per run',
  async () => {
  await isolated(async tempRoot => {
    const fake = fakeSources();
    const set = await prepareSources({ ...fake, tempRoot });
    try {
      assert.deepEqual(fake.requests.map(({ url, ref }) => [url, ref]), [
        ['https://github.com/taco3064/nibfin-core.git', 'refs/heads/main'],
        ['https://github.com/taco3064/nibfin-act.git', 'refs/heads/main'],
        ['https://github.com/taco3064/gh-nibfin.git', 'refs/heads/main'],
      ]);
      assert.deepEqual(fake.prepared, ['core', 'action', 'cli']);
      const before = JSON.stringify(set.sources);
      fake.upstream.cli = '4'.repeat(40);
      // Test cleanup is independent of the run-level source lifetime.
      const document = await run([{
        id: 'retained', group: 'local', title: 'Retained sources', timeoutMs: 2000,
        module: new URL('./fixtures/prepared.mjs', import.meta.url).href,
      }], [], { tempRoot, sources: set.sources });
      assert.equal(exitCode(document), 0);
      assert.equal(JSON.stringify(set.sources), before);
      assert.equal(fake.requests.length, 3);
      assert(Object.isFrozen(set.sources.cli));
      assert.throws(() => { set.sources.cli.commit = fake.upstream.cli; });
      for (const source of Object.values(set.sources)) await access(source.checkout);
      await access(set.sources.core.output.archive);
      // A later release consumer receives exactly the retained set.
      assert.equal(set.sources.cli.commit, commits.cli);
      const next = await prepareSources({ ...fake, tempRoot });
      try {
        assert.equal(next.sources.cli.commit, fake.upstream.cli);
        assert.notEqual(next.root, set.root);
        assert.equal(fake.requests.length, 6);
      } finally { await next.dispose(); }
    } finally { await set.dispose(); }
    await set.dispose();
    assert.equal(set.disposed, true);
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

for (const reason of ['missing main', 'acquisition unavailable', 'preparation failure']) {
  test(`${reason} rejects the entire set and cleans up settled work`, async () => {
    await isolated(async tempRoot => {
      const fake = fakeSources();
      const field = reason === 'preparation failure' ? 'prepare' : 'acquire';
      const original = fake[field];
      let settled = false;
      const options = { ...fake, tempRoot, [field]: async (...args) => {
        if (args[0].id !== 'action') return original(...args);
        await new Promise(resolve => setTimeout(resolve, 10));
        settled = true;
        throw new Error(reason);
      }, remove: async (path, flags) => {
        assert.equal(settled, true);
        await rm(path, flags);
      } };
      await assert.rejects(prepareSources(options), new RegExp(reason));
      assert.deepEqual(await readdir(tempRoot), []);
      assert.equal(fake.requests.filter(item => item.id === 'core').length, 1);
    });
  });
}

for (const consumer of ['action', 'cli']) {
  for (const key of Object.keys(pin)) {
    test(`${consumer} ${key} mismatch rejects without editing producer pins`,
  async () => {
      await isolated(async tempRoot => {
        const fake = fakeSources();
        const acquire = async (...args) => {
          const commit = await fake.acquire(...args);
          if (args[0].id === consumer) {
            const changed = { ...pin, [key]: 'incompatible' };
            await put(args[1], consumer === 'action' ? 'core-source.json' :
              'internal/cli/producers.json', consumer === 'action' ? changed : {
                core: changed, action: {
                  repository: 'taco3064/nibfin-act', commit: commits.action,
                },
              });
          }
          return commit;
        };
        await assert.rejects(prepareSources({ ...fake, acquire, tempRoot }),
          /INCOMPATIBLE_CORE_SOURCE/);
        assert.deepEqual(fake.prepared, ['core']);
        assert.deepEqual(await readdir(tempRoot), []);
      });
    });
  }
}

test('CLI Action declaration mismatch is explicit', async () => {
  await isolated(async tempRoot => {
    const fake = fakeSources();
    const acquire = async (...args) => {
      const commit = await fake.acquire(...args);
      if (args[0].id === 'cli') await put(args[1], 'internal/cli/producers.json', {
        core: pin, action: { repository: 'taco3064/nibfin-act', commit: commits.cli },
      });
      return commit;
    };
    await assert.rejects(prepareSources({ ...fake, acquire, tempRoot }),
      /INCOMPATIBLE_ACTION_SOURCE/);
  });
});

test('cleanup failure is visible, retains its location and can be retried', async () => {
  await isolated(async tempRoot => {
    let fail = true;
    const remove = async (path, flags) => {
      if (fail) throw new Error('remove denied');
      await rm(path, flags);
    };
    const set = await prepareSources({ ...fakeSources(), tempRoot, remove });
    await assert.rejects(set.dispose(), /SOURCE_CLEANUP_ERROR: retained/);
    assert.equal(set.disposed, false);
    await access(set.root);
    fail = false;
    await set.dispose();
    assert.deepEqual(await readdir(tempRoot), []);
    await assert.rejects(prepareSources({ ...fakeSources(), tempRoot,
      acquire: async () => { throw new Error('acquire failed'); },
      remove: async () => { throw new Error('cleanup failed'); },
    }), error => {
      assert.match(error.message, /acquire failed.*cleanup failed/);
      assert.equal(error.errors.length, 2);
      return true;
    });
  });
});

test('run owner cleans up on callback failure and reports cleanup as non-success',
  async () => {
  await isolated(async tempRoot => {
    await assert.rejects(withPreparedSources(async set => {
      await access(set.sources.cli.checkout);
      throw new Error('consumer failed');
    }, { ...fakeSources(), tempRoot }), /consumer failed/);
    assert.deepEqual(await readdir(tempRoot), []);
    const scenario = {
      id: 'pass', group: 'local', title: 'Synthetic', timeoutMs: 2000,
      module: new URL('./fixtures/behaviors.mjs?mode=pass', import.meta.url).href,
    };
    const document = await runPrepared([scenario], [], { sourceOptions: {
      ...fakeSources(), tempRoot,
      remove: async () => { throw new Error('cleanup failed'); },
    } });
    assert.equal(exitCode(document), 1);
    assert.match(document.errors[0], /SOURCE_CLEANUP_ERROR/);
  });
});

test('Git acquisition binds Core local main to its acquired commit without refetch',
  async () => {
  const calls = [];
  const command = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: `${commits.core}\n` };
  };
  const commit = await acquireSource(sourceRepositories[0], '/owned/core', {
    root: '/owned', env: {}, command,
  });
  assert.equal(commit, commits.core);
  assert.deepEqual(calls.map(call => call.file), ['git', 'git', 'git']);
  assert.deepEqual(calls[0].args, [
    'clone', '--no-checkout', '--depth=1', '--single-branch', '--no-tags',
    '--branch', 'main', '--', sourceRepositories[0].url, '/owned/core',
  ]);
  assert(calls[1].args.includes('refs/remotes/origin/main^{commit}'));
  assert.deepEqual(calls[2].args,
    ['-C', '/owned/core', 'checkout', '-B', 'main', commits.core]);
  await assert.rejects(acquireSource(sourceRepositories[0], '/owned/core', {
    root: '/owned', env: {}, command: async () => { throw new Error('missing main'); },
  }), /missing main/);
  assert.equal(calls.length, 3);
});

test('runPrepared success and preparation failure preserve JSON outcome rules',
  async () => {
  await isolated(async tempRoot => {
    const scenario = {
      id: 'prepared', group: 'local', title: 'Prepared', timeoutMs: 2000,
      module: new URL('./fixtures/prepared.mjs', import.meta.url).href,
    };
    const options = { sourceOptions: { ...fakeSources(), tempRoot } };
    const document = await runPrepared([scenario], [], options);
    assert.equal(exitCode(document), 0);
    assert.deepEqual(await readdir(tempRoot), []);
    const failure = await runPrepared([scenario], [], { sourceOptions: {
      ...fakeSources(), tempRoot,
      acquire: async () => { throw new Error('source unavailable'); },
    } });
    assert.equal(exitCode(failure), 1);
    assert.deepEqual(failure.results, []);
    assert.match(failure.errors[0], /source unavailable/);
    assert.deepEqual(await readdir(tempRoot), []);
    const empty = await runPrepared([], [], options);
    assert.equal(exitCode(empty), 1);
    assert.match(empty.errors[0], /NO_SCENARIOS/);
  });
});

test('a tag named main or invalid checkout identity cannot satisfy acquisition',
  async () => {
  let checkouts = 0;
  await assert.rejects(acquireSource(sourceRepositories[0], '/owned/core', {
    root: '/owned', env: {}, command: async (file, args) => {
      if (args.includes('rev-parse')) throw new Error('branch main missing');
      if (args.includes('checkout')) checkouts++;
      return { stdout: '' };
    },
  }), /branch main missing/);
  assert.equal(checkouts, 0);
  await assert.rejects(acquireSource(sourceRepositories[0], '/owned/core', {
    root: '/owned', env: {}, command: async () => ({ stdout: 'not a commit' }),
  }), /INVALID_CHECKOUT_IDENTITY/);
});

test('a callback throwing a falsy value still rejects and disposes', async () => {
  await isolated(async tempRoot => {
    let rejected = false;
    try {
      await withPreparedSources(() => { throw undefined; }, {
        ...fakeSources(), tempRoot,
      });
    } catch (error) {
      rejected = true;
      assert.equal(error, undefined);
    }
    assert(rejected);
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

test('unknown acquisition or producer termination retains owned resources', async () => {
  for (const phase of ['acquire', 'prepare']) {
    await isolated(async tempRoot => {
      const fake = fakeSources();
      const original = fake[phase];
      let removals = 0;
      await assert.rejects(prepareSources({ ...fake, tempRoot,
        [phase]: async (...args) => {
          await original(...args);
          throw Object.assign(new Error('unconfirmed process termination'), {
            terminationUnknown: true,
          });
        },
        remove: async () => { removals++; },
      }), /SOURCE_TERMINATION_UNKNOWN: retained/);
      assert.equal(removals, 0);
      const retained = await readdir(tempRoot);
      assert.equal(retained.length, 1);
      await access(join(tempRoot, retained[0], 'core'));
      // These fixtures have no live producers. isolated() removes the retained
      // test-only resources after the assertions; production recovery is external.
    });
  }
});

test('unknown consumer termination retains the prepared set for recovery', async () => {
  await isolated(async tempRoot => {
    let retained;
    await assert.rejects(withPreparedSources(async set => {
      retained = set;
      throw new Error('wrapped producer failure', {
        cause: Object.assign(new Error('termination unknown'), {
          terminationUnknown: true,
        }),
      });
    }, { ...fakeSources(), tempRoot }), /wrapped producer failure/);
    assert.equal(retained.disposed, false);
    await access(retained.sources.core.checkout);
    // No process was started by this fixture; explicit test recovery is safe.
    await retained.dispose();
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

test('consumer checkouts retain detached identities', async () => {
  for (const source of sourceRepositories.filter(row => row.id !== 'core')) {
    const calls = [];
    await acquireSource(source, '/owned/consumer', {
      root: '/owned', env: {}, command: async (file, args) => {
        calls.push(args);
        return { stdout: `${commits[source.id]}\n` };
      },
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], ['-C', '/owned/consumer', 'checkout',
      '--detach', commits[source.id]]);
  }
});

test('release ownership cannot be reused after failure or disposal', async () => {
  await isolated(async tempRoot => {
    const set = await prepareSources({ ...fakeSources(), tempRoot,
      command: async () => ({ stdout: 'invalid source identity' }),
    });
    await assert.rejects(set.preflightRelease('1.2.3'), /source commit changed/);
    await assert.rejects(set.preflightRelease('1.2.3'), /stale or disposed/);
    await set.dispose();
    await assert.rejects(set.preflightRelease('1.2.3'), /stale or disposed/);
    assert.deepEqual(await readdir(tempRoot), []);
  });
});
