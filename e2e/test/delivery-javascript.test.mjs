import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMergedJavaScript } from '../delivery-javascript.mjs';
import { javascriptRequests } from '../delivery-pair.mjs';
import { sourceCommand } from '../source-process.mjs';

// Git observations are synthetic; JavaScript executes in a disposable directory.
async function executeProgram(t, program, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-javascript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = 'fixtures/generated/owned/program.mjs';
  await mkdir(join(root, 'fixtures/generated/owned'), { recursive: true });
  await writeFile(join(root, path), options.source ?? program.content);
  const binding = { ...program, path, repository: 'fixture/repository', issue: 29,
    requestId: 'controlled', head: 'b'.repeat(40), mergeCommit: 'c'.repeat(40) };
  let disposed = false;
  const result = await assertMergedJavaScript(binding, async target => {
    assert.deepEqual(target, { repository: binding.repository,
      mergeCommit: binding.mergeCommit });
    return { root, dispose: async () => {
      disposed = true;
      await rm(root, { recursive: true, force: true });
    } };
  }, undefined, async (file, args, context) => {
    if (file === 'git') return { stdout: args[0] === 'status'
      ? options.status ?? '' : `${options.head ?? binding.mergeCommit}\n` };
    return sourceCommand(file, args, context);
  });
  assert.equal(disposed, true);
  await assert.rejects(access(root), { code: 'ENOENT' });
  return result;
}

for (const program of javascriptRequests) {
  test(`exact output executes once: ${program.stdout.trim()}`, async t => {
    const result = await executeProgram(t, program);
    assert.equal(result.state, 'satisfied');
    assert.equal(result.stdout, program.stdout);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.checkout, { commit: 'c'.repeat(40), clean: true });
  });
}
for (const [name, content] of Object.entries({
  missing: 'export const ready = true;\n',
  repeated: 'process.stdout.write("NIBFIN_E2E_READY\\n".repeat(2));\n',
  swapped: javascriptRequests[1].content,
  extra: 'process.stdout.write("NIBFIN_E2E_READY\\nextra\\n");\n',
  unsuccessful: 'process.stdout.write("NIBFIN_E2E_READY\\n"); process.exit(1);\n',
})) {
  test(`execution rejects ${name} output`, async t => {
    const program = { content, stdout: javascriptRequests[0].stdout };
    assert.notEqual((await executeProgram(t, program)).state, 'satisfied');
  });
}

test('different content, dirty checkout and stale merge cannot pass', async t => {
  for (const options of [{ source: 'process.stdout.write("unexpected");' },
    { status: ' M fixtures/generated/owned/program.mjs\n' },
    { head: 'a'.repeat(40) }]) {
    const result = await executeProgram(t, javascriptRequests[0], options);
    assert.notEqual(result.state, 'satisfied');
  }
});
