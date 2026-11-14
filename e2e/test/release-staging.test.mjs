import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseFixture as fixture } from './release-fixture.mjs';

test('complete producer metadata and checksum set passes validation', async t => {
  await (await fixture(t)).validate();
});
for (const path of ['release-core/source-pin.json', 'release-core/nibfin-core.tar.gz',
  'release-core/SHA256SUMS', 'action/src/main.mjs', 'cli/dist/gh-nibfin_linux_arm64',
  'cli/dist/manifest.json', 'cli/dist/SHA256SUMS']) {
  test(`partial staging rejects missing ${path}`, async t => {
    const f = await fixture(t);
    await rm(join(f.root, path));
    await assert.rejects(f.validate());
  });
}
for (const path of ['release-core/nibfin-core.tar.gz', 'cli/dist/gh-nibfin_darwin_amd64',
  'cli/dist/SHA256SUMS', 'action/core-source.json', 'action/package-lock.json']) {
  test(`inconsistent staging rejects modified ${path}`, async t => {
    const f = await fixture(t);
    await f.put(path, '{}');
    await assert.rejects(f.validate());
  });
}
test('symlinked staged output fails closed', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'cli/dist/gh-nibfin_linux_amd64');
  await rm(path);
  await symlink(join(f.root, 'action/src/main.mjs'), path);
  await assert.rejects(f.validate(), /UNSUPPORTED_PRODUCER/);
});
for (const product of ['core', 'action']) {
  test(`malformed ${product} success fails closed`, async t => {
    const f = await fixture(t);
    f.staged[product].stdout = '{}';
    await assert.rejects(f.validate(), /RELEASE_STAGING/);
  });
}
test('native verifier failure prevents staging success', async t => {
  const f = await fixture(t);
  f.context.command = async () => { throw new Error('invalid native archive'); };
  await assert.rejects(f.validate(), /invalid native archive/);
});
