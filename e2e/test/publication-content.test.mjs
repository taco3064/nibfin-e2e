import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseFixture } from './release-fixture.mjs';
import { capturePublication, digest } from '../publication-content.mjs';

const objectHash = (type, bytes) => createHash('sha1')
  .update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

test('captures validated assets and the versioned Action tree', async t => {
  const f = await releaseFixture(t);
  await f.validate();
  const sources = Object.values(f.sources).map(({ id, repository, ref, commit }) =>
    ({ id, repository, ref, commit }));
  const rootEntries = [
    ['100644', 'blob', '1'.repeat(40), 'core-source.json'],
    ['100644', 'blob', '2'.repeat(40), 'package-lock.json'],
    ['100644', 'blob', '3'.repeat(40), 'package.json'],
    ['040000', 'tree', '4'.repeat(40), 'src'],
  ];
  const plan = await capturePublication({ handoff: { version: '1.2.3', sources },
    prepared: { sources: f.sources, root: f.root }, staged: f.staged,
  }, async (file, args) => {
    assert.equal(file, 'git');
    assert.deepEqual(args, ['ls-tree', '-z', 'a'.repeat(40)]);
    return { stdout: rootEntries.map(([mode, type, sha, path]) =>
      `${mode} ${type} ${sha}\t${path}`).join('\0') + '\0' };
  });
  assert.equal(plan.repositories[0].assets.length, 3);
  assert.equal(plan.repositories[2].assets.length, 8);
  for (const row of plan.repositories) {
    for (const asset of row.assets) {
      assert.equal(digest(Buffer.from(asset.content, 'base64')), asset.sha256);
    }
  }
  const action = plan.repositories[1];
  assert.notEqual(action.target, action.commit);
  const tree = action.objects.find(row => row.kind === 'tree');
  assert.deepEqual(tree.entries[0], { mode: '100644', type: 'blob',
    sha: '1'.repeat(40), path: 'core-source.json' });
  assert.equal(tree.entries[3].sha, '4'.repeat(40));
  for (const name of ['package.json', 'package-lock.json']) {
    const bytes = await readFile(join(f.sources.action.checkout, name));
    const entry = tree.entries.find(row => row.path === name);
    assert.equal(entry.sha, objectHash('blob', bytes));
    assert.equal(JSON.parse(bytes).version, '1.2.3');
  }
  const treeBytes = Buffer.concat(tree.entries.map(row => Buffer.concat([
    Buffer.from(`${Number(row.mode)} ${row.path}\0`), Buffer.from(row.sha, 'hex'),
  ])));
  assert.equal(tree.sha, objectHash('tree', treeBytes));
  const commit = action.objects.find(row => row.kind === 'commit');
  const identity = 'Nibfin Release <release@nibfin.invalid> 0 +0000';
  const bytes = Buffer.from(`tree ${tree.sha}\nparent ${action.commit}\n` +
    `author ${identity}\ncommitter ${identity}\n\nRelease 1.2.3\n`);
  assert.equal(commit.sha, objectHash('commit', bytes));
  assert.equal(action.target, commit.sha);
  assert.equal(plan.repositories[0].target, sources[0].commit);
  assert.equal(plan.repositories[2].target, sources[2].commit);
});
