import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenarios, select } from '../registry.mjs';
import { execute } from '../execution.mjs';
import { verify } from '../scenarios/project-configuration.mjs';

const scenario = select(scenarios, ['project-configuration'])[0];
test('project contract is selectable and requires prepared Core', async () => {
  assert.equal(scenario.id, 'project-configuration.local');
  const result = await execute(scenario);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason.code, 'PREREQUISITE_MISSING');
});
test('incomplete observations cannot pass project assertions', () => {
  for (const value of [undefined, {}, { jobs: true }, { roles: true },
    { jobs: true, roles: false }]) assert.equal(verify(value), false);
});
test('unusable source fails explicitly, sanitizes diagnostics and cleans workspace',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-failure-test-'));
    try {
      const result = await execute(scenario, { tempRoot: root, sources: {
        core: { checkout: join(root, 'missing-core') },
      } });
      assert.equal(result.outcome, 'failing');
      assert.equal(result.reason.message, 'PROJECT_CONFIGURATION_CONTRACT_FAILED');
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
