import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = new URL('../../', import.meta.url);
const read = async path => (await readFile(new URL(path, repo), 'utf8'))
  .replaceAll('\r\n', '\n');

test('PR CI runs only the local verifier with read-only access', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  const manifest = JSON.parse(await read('package.json'));
  assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches: \[main\]/m);
  assert.match(workflow, /^permissions:\n  contents: read\n\njobs:/m);
  assert.match(workflow, /^  verify:\n    runs-on: ubuntu-24\.04$/m);
  assert.match(workflow, /^          persist-credentials: false$/m);
  assert.deepEqual([...workflow.matchAll(/^        run: (.+)$/gm)].map(m => m[1]), [
    '|', 'npm ci --ignore-scripts', 'npm --ignore-scripts run verify',
  ]);
  assert.doesNotMatch(workflow, /secrets\.|self-hosted|contents: write|workflow_call/);
  assert.equal(manifest.scripts.verify, 'node e2e/verify.mjs');
  const verifier = await read('e2e/verify.mjs');
  assert.match(verifier, /\['--test', 'e2e\/test\/\*\.test\.mjs'\]/);
  assert.doesNotMatch(verifier, /cli\.mjs|publish|registry\.mjs/);
});

test('the verify entry propagates a failing fixture assertion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-ci-contract-'));
  try {
    const fixtureDir = join(root, 'e2e', 'test');
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(join(fixtureDir, 'deliberate.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('deliberate failure', () => assert.equal(1, 2));",
    ].join('\n'));
    const verifier = fileURLToPath(new URL('e2e/verify.mjs', repo));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [verifier], {
      cwd: root, encoding: 'utf8', env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /deliberate failure/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
