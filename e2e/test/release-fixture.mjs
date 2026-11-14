import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sourceRepositories } from '../source-checkout.mjs';
import { validateReleaseStaging } from '../release-staging.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-staging-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = Object.fromEntries(sourceRepositories.map(source => [source.id,
    { ...source, checkout: join(root, source.id), commit: 'a'.repeat(40) }]));
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  };
  const pin = { repository: sources.core.repository, commit: sources.core.commit,
    releaseVersion: '1.2.3', archiveHash: hash('archive'), manifestHash: 'b'.repeat(64) };
  sources.core.output = { pin };
  const coreDirectory = join(root, 'release-core');
  const metadata = { entry: 'src/main.mjs', runtime: `node${
    process.versions.node.split('.')[0]}` };
  const files = {
    'release-core/nibfin-core.tar.gz': 'archive',
    'release-core/source-pin.json': JSON.stringify(pin),
    'release-core/SHA256SUMS': `${pin.archiveHash}  nibfin-core.tar.gz\n`,
    'core/src/source-install.mjs': 'installer',
    'core/src/source-package.mjs': 'verifier',
    'action/scripts/release-tree.mjs': 'tree',
    'action/src/main.mjs': 'entry',
    'action/package.json': JSON.stringify({ version: '1.2.3' }),
    'action/package-lock.json': JSON.stringify({ version: '1.2.3',
      packages: { '': { version: '1.2.3' } } }),
    'action/core-source.json': JSON.stringify(pin),
    'cli/internal/cli/producers.json': JSON.stringify({ core: pin,
      action: { repository: sources.action.repository, commit: sources.action.commit } }),
  };
  const targets = [];
  const sums = [];
  for (const os of ['linux', 'darwin', 'windows']) {
    for (const arch of ['amd64', 'arm64']) {
      const filename = `gh-nibfin_${os}_${arch}${os === 'windows' ? '.exe' : ''}`;
      const binary = Buffer.alloc(128);
      if (os === 'linux') {
        Buffer.from([127, 69, 76, 70, 2, 1]).copy(binary);
        binary.writeUInt16LE(2, 16);
        binary.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18);
      } else if (os === 'darwin') {
        binary.writeUInt32LE(0xfeedfacf);
        binary.writeUInt32LE(arch === 'amd64' ? 0x01000007 : 0x0100000c, 4);
        binary.writeUInt32LE(2, 12);
      } else {
        binary.write('MZ');
        binary.writeUInt32LE(64, 60);
        binary.writeUInt32LE(0x00004550, 64);
        binary.writeUInt16LE(arch === 'amd64' ? 0x8664 : 0xaa64, 68);
        binary.writeUInt16LE(2, 86);
      }
      files[`cli/dist/${filename}`] = binary;
      const sha256 = hash(binary);
      targets.push({ os, arch, filename, size: binary.length, sha256 });
      sums.push(`${sha256}  ${filename}`);
    }
  }
  const manifest = JSON.stringify({ version: '1.2.3', targets });
  files['cli/dist/manifest.json'] = manifest;
  files['cli/dist/SHA256SUMS'] = [...sums,
    `${hash(manifest)}  manifest.json`].join('\n') + '\n';
  for (const [path, value] of Object.entries(files)) await put(path, value);
  const staged = { coreDirectory,
    core: { stdout: JSON.stringify({ ...pin, status: 'verified-build',
      output: coreDirectory }) },
    action: { stdout: JSON.stringify({ status: 'tag-ready', version: '1.2.3',
      ...metadata }) }, cli: { stdout: '' } };
  const context = { root, env: {}, command: async () =>
    ({ stdout: JSON.stringify(metadata), stderr: '' }) };
  const validate = () => validateReleaseStaging(sources, '1.2.3', staged, context);
  return { root, sources, staged, context, put, validate, files, metadata };
}
