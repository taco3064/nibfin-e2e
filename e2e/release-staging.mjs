import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateExecutable } from './release-executable.mjs';
import { producerFile, verifyCompatibility } from './source-producers.mjs';

const requireThat = (condition, message) => {
  if (!condition) throw new Error(`RELEASE_STAGING: ${message}`);
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async (root, path) => JSON.parse(await readFile(
  await producerFile(root, path), 'utf8',
));
async function bytes(root, path) {
  const value = await readFile(await producerFile(root, path));
  requireThat(value.length > 0, `empty ${path}`);
  return value;
}
async function inventory(root, names) {
  requireThat(JSON.stringify((await readdir(root)).sort()) ===
    JSON.stringify([...names].sort()), 'incomplete or unexpected inventory');
}
async function checksums(root, names) {
  const expected = [];
  for (const name of names) expected.push(`${hash(await bytes(root, name))}  ${name}`);
  const actual = (await bytes(root, 'SHA256SUMS')).toString();
  requireThat(actual === expected.join('\n') + '\n', 'checksum mismatch');
}

export async function validateReleaseStaging(sources, version, staged, context) {
  const core = JSON.parse(staged.core.stdout);
  const directory = staged.coreDirectory;
  await inventory(directory, ['nibfin-core.tar.gz', 'source-pin.json', 'SHA256SUMS']);
  const pin = await json(directory, 'source-pin.json');
  requireThat(core.status === 'verified-build' && core.output === directory,
    'invalid Core success');
  for (const [key, expected] of Object.entries({
    repository: sources.core.repository, commit: sources.core.commit,
    releaseVersion: version,
  })) requireThat(pin[key] === expected && core[key] === expected,
    `Core ${key} mismatch`);
  for (const key of ['archiveHash', 'manifestHash']) {
    requireThat(/^[a-f0-9]{64}$/.test(pin[key] ?? '') && core[key] === pin[key],
      `Core ${key} mismatch`);
  }
  requireThat(hash(await bytes(directory, 'nibfin-core.tar.gz')) === pin.archiveHash,
    'Core archive mismatch');
  await checksums(directory, ['nibfin-core.tar.gz']);
  // Reuse Core's installer and manifest/content verifier rather than implementing
  // archive extraction or maintaining a second product packaging specification.
  const install = await producerFile(sources.core.checkout, 'src/source-install.mjs');
  const verify = await producerFile(sources.core.checkout, 'src/source-package.mjs');
  await context.command(process.execPath, ['--input-type=module', '-e', [
    "import { readFile } from 'node:fs/promises';",
    "import { pathToFileURL } from 'node:url';",
    `const { installSource } = await import(pathToFileURL(${JSON.stringify(install)}));`,
    'const { verifyInstalledSource } = await import(pathToFileURL(' +
      JSON.stringify(verify) + '));',
    `const pin = ${JSON.stringify(pin)};`,
    `const target = ${JSON.stringify(join(context.root, 'release-install'))};`,
    'await installSource(await readFile(' +
      JSON.stringify(join(directory, 'nibfin-core.tar.gz')) + '), target, pin);',
    'await verifyInstalledSource(target, pin);',
  ].join('\n')], { cwd: sources.core.checkout, env: context.env });

  const action = JSON.parse(staged.action.stdout);
  const actionRoot = sources.action.checkout;
  const pkg = await json(actionRoot, 'package.json');
  const lock = await json(actionRoot, 'package-lock.json');
  requireThat(action.status === 'tag-ready' && action.version === version &&
    pkg.version === version && lock.version === version &&
    lock.packages?.['']?.version === version, 'Action version or success mismatch');
  await producerFile(actionRoot, 'scripts/release-tree.mjs');
  const tree = await context.command(process.execPath, ['--input-type=module', '-e',
    "import { releaseTree } from './scripts/release-tree.mjs'; " +
    'const { entry, runtime } = await releaseTree(); ' +
    'console.log(JSON.stringify({ entry, runtime }));',
  ], { cwd: actionRoot, env: context.env });
  const metadata = JSON.parse(tree.stdout);
  requireThat(action.entry === metadata.entry && action.runtime === metadata.runtime &&
    action.runtime === `node${process.versions.node.split('.')[0]}`,
  'Action entry/runtime mismatch');
  await producerFile(actionRoot, action.entry);

  const cliRoot = join(sources.cli.checkout, 'dist');
  const manifest = await json(cliRoot, 'manifest.json');
  requireThat(manifest.version === version && Array.isArray(manifest.targets) &&
    manifest.targets.length === 6, 'CLI version or target count mismatch');
  const names = [];
  for (const os of ['linux', 'darwin', 'windows']) {
    for (const arch of ['amd64', 'arm64']) {
      const name = `gh-nibfin_${os}_${arch}${os === 'windows' ? '.exe' : ''}`;
      const rows = manifest.targets.filter(row => row.os === os && row.arch === arch);
      const data = await bytes(cliRoot, name);
      requireThat(rows.length === 1 && rows[0].filename === name &&
        rows[0].size === data.length && rows[0].sha256 === hash(data),
      `CLI target mismatch: ${name}`);
      validateExecutable(data, os, arch);
      names.push(name);
    }
  }
  await inventory(cliRoot, [...names, 'manifest.json', 'SHA256SUMS']);
  await checksums(cliRoot, [...names, 'manifest.json']);
  // Consumer pins identify the versionless package used by mandatory E2E.
  // Core releaseVersion changes the release manifest/archive digests, while the
  // producer and installer bind that presentation to the same acquired commit.
  await verifyCompatibility(sources, sources.core.output);
}
