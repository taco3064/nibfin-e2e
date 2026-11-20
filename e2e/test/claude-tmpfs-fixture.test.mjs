import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { workerFixture, capturedTmpfs } from '../scenarios/claude-worker-fixture.mjs';
import { modelFixture } from '../scenarios/claude-model-fixture.mjs';

const core = process.env.NIBFIN_TEST_CORE;
const commit = process.env.NIBFIN_TEST_CORE_COMMIT;
const context = { sources: { core: { checkout: core, commit,
  repository: 'taco3064/nibfin-core' } } };
const skip = !core || !commit ? 'Prepared Core source and identity required' : false;

test('tmpfs capture preserves multiple requested mounts without a policy copy', () => {
  assert.deepEqual(capturedTmpfs(['create', '--env', 'VALUE=--tmpfs=/ignored:rw',
    '--tmpfs=/worker-cache:rw,exec', '--tmpfs=/model/config:rw,noexec']), {
    '/worker-cache': 'rw,exec', '/model/config': 'rw,noexec',
  });
  assert.deepEqual(capturedTmpfs(['create', '--read-only']), {});
});

for (const mutated of [false, true]) {
  test(`worker tmpfs inspection follows launch and preserves rejection ${mutated}`,
    { skip }, async () => {
      const f = await workerFixture(context, 'accept');
      let observed;
      f.controls.mutate = container => {
        observed = structuredClone(container.HostConfig.Tmpfs);
        if (mutated) container.HostConfig.Tmpfs = {};
      };
      try {
        if (mutated) await assert.rejects(f.worker.start());
        else await f.worker.start();
        const create = f.calls.find(args => args[0] === 'create');
        assert(create);
        assert.deepEqual(observed, capturedTmpfs(create));
        assert(Object.keys(observed).length > 0);
        assert.equal(f.calls.some(args => args[0] === 'start'), !mutated);
        assert.equal((await f.worker.settle()).status, 'terminated');
      } finally {
        await f.worker.settle();
        await f.close();
        await assert.rejects(access(f.root));
      }
    });

  test(`model tmpfs inspection follows launch and preserves rejection ${mutated}`,
    { skip }, async () => {
      const f = await modelFixture(context);
      let observed;
      f.modelControls.mutate = container => {
        observed = structuredClone(container.HostConfig.Tmpfs);
        if (mutated) container.HostConfig.Tmpfs = {};
      };
      try {
        if (mutated) await assert.rejects(f.execute());
        else assert.equal((await f.execute()).status, 'completed');
        const create = f.calls.find(args => args[0] === 'create' &&
          args.includes('--user=1001:1001'));
        assert(create);
        assert.deepEqual(observed, capturedTmpfs(create));
        assert(Object.keys(observed).length > 0);
        assert.equal(f.calls.some(args => args[0] === 'start' && args[1] === '-ai'),
          !mutated);
      } finally {
        await f.runner.requestCleanup(f.admission.executionId);
        await f.runner.retire(f.admission.executionId);
        await f.close();
        await assert.rejects(access(f.root));
      }
    });
}
