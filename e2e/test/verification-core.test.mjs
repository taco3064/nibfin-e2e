import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withVerificationCore } from '../verification-core.mjs';

test('verification supplies acquired Core to tests and cleans it on test failure',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-owner-test-'));
    let acquired;
    try {
      await assert.rejects(withVerificationCore(async env => {
        assert.equal(env.NIBFIN_TEST_CORE, acquired);
        assert.equal(env.NIBFIN_TEST_CORE_COMMIT, 'a'.repeat(40));
        assert.equal(env.TEST_ONLY, 'preserved');
        throw new Error('test failure');
      }, { tempRoot: root, env: { TEST_ONLY: 'preserved' },
        async acquire(source, path) {
          assert.equal(source.repository, 'taco3064/nibfin-core');
          acquired = path;
          return 'a'.repeat(40);
        } }), /test failure/);
      await assert.rejects(access(acquired));
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('verification fails rather than skipping when acquisition fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verification-failure-test-'));
  let invoked = false;
  try {
    await assert.rejects(withVerificationCore(() => { invoked = true; }, {
      env: {}, tempRoot: root,
      async acquire() { throw new Error('source unavailable'); },
    }), /source unavailable/);
    assert.equal(invoked, false);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verification preserves caller source ownership and rejects partial inputs',
  async () => {
    const env = { NIBFIN_TEST_CORE: '/caller/core',
      NIBFIN_TEST_CORE_COMMIT: 'b'.repeat(40) };
    assert.equal(await withVerificationCore(value => value, { env }), env);
    for (const input of [{ NIBFIN_TEST_CORE: '/caller/core' },
      { NIBFIN_TEST_CORE_COMMIT: 'b'.repeat(40) },
      { ...env, NIBFIN_TEST_CORE_COMMIT: 'invalid' }]) {
      await assert.rejects(withVerificationCore(() => assert.fail(), { env: input }),
        /PREPARED_CORE_INPUTS_INCOMPLETE/);
    }
  });
