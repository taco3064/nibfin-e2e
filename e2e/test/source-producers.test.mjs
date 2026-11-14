import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSources } from '../sources.mjs';
import { producerFile } from '../source-producers.mjs';
import { fakeSources, pin, put } from './source-fixture.mjs';

async function fixture(check) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'nibfin-producer-test-'));
  const fake = fakeSources();
  const calls = [];
  const command = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === 'scripts/package-ci.mjs') {
      await put(options.cwd, 'distribution/source-pin.json', pin);
      await put(options.cwd, 'distribution/nibfin-core.tar.gz', 'fake archive');
      return { stdout: JSON.stringify({ status: 'verified-build', ...pin }) };
    }
    if (args.includes('--input-type=module')) {
      return { stdout: JSON.stringify({ using: 'node24', main: 'src/main.mjs' }) };
    }
    if (file === 'go') await put(options.cwd, 'gh-nibfin', 'fake binary');
    return { stdout: '', stderr: '' };
  };
  try { await check({ tempRoot, fake, calls, command }); }
  finally { await rm(tempRoot, { recursive: true, force: true }); }
}

test('production preparation invokes maintained entries and retains their outputs',
  async () => {
  await fixture(async ({ tempRoot, fake, calls, command }) => {
    const set = await prepareSources({ tempRoot, acquire: fake.acquire, command });
    try {
      assert.deepEqual(calls.map(({ file, args }) => [file, args.slice(0, 2)]), [
        [process.execPath, ['scripts/package-ci.mjs']],
        ['npm', ['ci', '--ignore-scripts']],
        ['npm', ['run', 'build']],
        [process.execPath, ['--input-type=module', '-e']],
        ['go', ['build', '-trimpath']],
      ]);
      assert.equal(calls[0].options.env.SOURCE_COMMIT, pin.commit);
      assert.equal(calls[0].options.env.GITHUB_OUTPUT, undefined);
      for (const call of calls) {
        assert.equal(call.options.env.GH_TOKEN, undefined);
        assert.equal(call.options.env.GITHUB_TOKEN, undefined);
        assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, '1');
        assert(call.options.cwd.startsWith(set.root));
        assert.equal(call.options.env.TMPDIR, set.root);
      }
      assert.equal(set.sources.core.output.pin.commit, pin.commit);
      assert.equal(set.sources.action.output.entry,
        join(set.sources.action.checkout, 'src/main.mjs'));
      assert.equal(await readFile(set.sources.cli.output.entry, 'utf8'), 'fake binary');
      assert.deepEqual(JSON.parse(await readFile(join(set.sources.action.checkout,
        'core-source.json'), 'utf8')), pin);
    } finally { await set.dispose(); }
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

for (const path of ['scripts/package-ci.mjs', 'action.yml', 'go.mod']) {
  test(`missing producer entry ${path} cannot return a partial set`, async () => {
    await fixture(async ({ tempRoot, fake, command }) => {
      const acquire = async (...args) => {
        const commit = await fake.acquire(...args);
        await rm(join(args[1], path), { force: true });
        return commit;
      };
      await assert.rejects(prepareSources({ tempRoot, acquire, command }),
        /SOURCE_PREPARATION_ERROR/);
      assert.deepEqual(await readdir(tempRoot), []);
    });
  });
}

for (const producer of ['core', 'action', 'cli']) {
  test(`${producer} command failure is awaited and fails preparation`, async () => {
    await fixture(async ({ tempRoot, fake, command }) => {
      let finished = false;
      await assert.rejects(prepareSources({ tempRoot, acquire: fake.acquire,
        command: async (file, args, options) => {
          if (options.cwd.endsWith(`/${producer}`)) {
            await new Promise(resolve => setTimeout(resolve, 10));
            finished = true;
            throw new Error('producer check rejected');
          }
          return command(file, args, options);
        }, remove: async (path, options) => {
          assert(finished);
          await rm(path, options);
        },
      }), /producer check rejected/);
      assert.deepEqual(await readdir(tempRoot), []);
    });
  });
}

for (const mode of ['invalid status', 'missing archive', 'wrong package identity',
  'unsupported build', 'bad metadata', 'missing binary']) {
  test(`${mode} is an explicit preparation failure`, async () => {
    await fixture(async ({ tempRoot, fake, command }) => {
      const acquire = async (...args) => {
        const commit = await fake.acquire(...args);
        if (mode === 'unsupported build' && args[0].id === 'action') {
          await put(args[1], 'package.json', { scripts: {} });
        }
        return commit;
      };
      await assert.rejects(prepareSources({ tempRoot, acquire,
        command: async (file, args, options) => {
          const result = await command(file, args, options);
          if (args[0] === 'scripts/package-ci.mjs') {
            if (mode === 'invalid status') return { stdout: '{"status":"failed"}' };
            if (mode === 'missing archive') {
              await rm(join(options.cwd, 'distribution/nibfin-core.tar.gz'));
            }
            if (mode === 'wrong package identity') {
              await put(options.cwd, 'distribution/source-pin.json', {
                ...pin, commit: '9'.repeat(40),
              });
            }
          }
          if (mode === 'bad metadata' && args.includes('--input-type=module')) {
            return { stdout: '{"using":"docker","main":"src/main.mjs"}' };
          }
          if (mode === 'missing binary' && file === 'go') {
            await rm(join(options.cwd, 'gh-nibfin'));
          }
          return result;
        },
      }), /SOURCE_PREPARATION_ERROR/);
      assert.deepEqual(await readdir(tempRoot), []);
    });
  });
}

test('producer output paths cannot escape checkouts through paths or links', async () => {
  await fixture(async ({ tempRoot }) => {
    const file = await put(tempRoot, 'file', 'local');
    await symlink(file, join(tempRoot, 'linked'));
    await assert.rejects(producerFile(tempRoot, '../outside'));
    await assert.rejects(producerFile(tempRoot, file));
    await assert.rejects(producerFile(tempRoot, 'linked'));
    assert.equal(await producerFile(tempRoot, 'file'), file);
  });
});
