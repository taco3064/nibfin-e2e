import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify, run } from '../scenarios/isolation-local.mjs';
import { verifyClaude, claudeCategories } from '../scenarios/claude-controls.mjs';
import { workerFixture } from '../scenarios/claude-worker-fixture.mjs';

const complete = {
  roles: 5, workerInspection: 11, modelInspection: 12,
  termination: 2, sessions: 7, configuration: 2,
};
test('local success requires every Claude category and existing controls', () => {
  const actual = { bindings: 7, policies: true, claude: complete };
  assert.equal(verify(actual), true);
  assert.equal(verify({ ...actual, claude: undefined }), false);
  assert.equal(verify({ ...actual, bindings: 6 }), false);
  assert.equal(verify({ ...actual, policies: false }), false);
  for (const key of claudeCategories) {
    const omitted = { ...complete };
    delete omitted[key];
    assert.equal(verifyClaude(omitted), false);
    for (const value of [false, null, 0, complete[key] - 1, complete[key] + 1]) {
      assert.equal(verify({ ...actual, claude: { ...complete, [key]: value } }),
        false);
    }
  }
});
test('fixture setup cleans owned files on source and constructor failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e2e-claude-cleanup-'));
  const checkout = join(root, 'source');
  const owned = join(root, 'owned');
  try {
    await mkdir(join(checkout, 'src'), { recursive: true });
    await mkdir(owned);
    await writeFile(join(checkout, 'src/claude-work-launcher.mjs'), `
export class ClaudeWorkWorker {
  constructor() { throw new Error('synthetic-private-constructor'); }
}
`);
    const context = { sources: { core: { checkout } } };
    for (const mode of ['source-missing', 'constructor-fails']) {
      if (mode === 'constructor-fails') {
        for (const name of ['egress-proxy.mjs', 'claude-package-proxy.mjs']) {
          await writeFile(join(checkout, 'src', name), '// Synthetic source');
        }
      }
      await assert.rejects(workerFixture(context, 'deliver', {}, owned));
      assert.deepEqual(await readdir(owned), []);
    }
    await assert.rejects(run(context), error => {
      assert.equal(error.message, 'ISOLATION_CONTRACT_ASSERTION_FAILED');
      assert.equal(error.message.includes(root), false);
      assert.equal(error.message.includes('synthetic-private'), false);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
