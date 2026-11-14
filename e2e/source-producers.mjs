import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { sourceCommand } from './source-process.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export async function producerFile(root, path) {
  if (typeof path !== 'string' || isAbsolute(path)) {
    throw new Error('UNSUPPORTED_PRODUCER_PATH');
  }
  const target = join(root, path);
  const inside = relative(root, target);
  if (inside.startsWith('..') || await realpath(target) !== target ||
      !(await lstat(target)).isFile()) {
    throw new Error(`UNSUPPORTED_PRODUCER_FILE: ${path}`);
  }
  return target;
}

function matchingPin(pin, expected) {
  if (!pin || ['repository', 'commit', 'archiveHash', 'manifestHash'].some(
    key => pin[key] !== expected[key],
  )) throw new Error('INCOMPATIBLE_CORE_SOURCE');
}

// These declarations belong to the consumers. Never rewrite or substitute them.
export async function verifyCompatibility(sources, coreOutput) {
  const actionPin = await readJson(await producerFile(
    sources.action.checkout, 'core-source.json',
  ));
  const cliPins = await readJson(await producerFile(
    sources.cli.checkout, 'internal/cli/producers.json',
  ));
  matchingPin(actionPin, coreOutput.pin);
  matchingPin(cliPins.core, coreOutput.pin);
  if (cliPins.action?.repository !== sources.action.repository ||
      cliPins.action?.commit !== sources.action.commit) {
    throw new Error('INCOMPATIBLE_ACTION_SOURCE');
  }
}

export async function prepareProducer(source, context) {
  const { checkout, id, commit } = source;
  const { command = sourceCommand, env } = context;
  const invoke = async (file, args, extra = {}) => {
    const result = await command(file, args, { cwd: checkout, env, ...extra });
    if (result.stderr) context.diagnostic?.(result.stderr);
    return result;
  };
  if (id === 'core') {
    await producerFile(checkout, 'scripts/package-ci.mjs');
    const built = await invoke(process.execPath, ['scripts/package-ci.mjs'], {
      env: { ...env, SOURCE_COMMIT: commit },
    });
    const result = JSON.parse(built.stdout);
    const pinPath = await producerFile(checkout, 'distribution/source-pin.json');
    const pin = await readJson(pinPath);
    if (result.status !== 'verified-build' ||
        pin.repository !== source.repository || pin.commit !== commit ||
        !/^[a-f0-9]{64}$/.test(pin.archiveHash ?? '') ||
        !/^[a-f0-9]{64}$/.test(pin.manifestHash ?? '')) {
      throw new Error('UNSUPPORTED_CORE_PACKAGE');
    }
    matchingPin(result, pin);
    return {
      archive: await producerFile(checkout, 'distribution/nibfin-core.tar.gz'),
      pinPath, pin: Object.freeze(pin),
    };
  }
  if (id === 'action') {
    const manifest = await readJson(await producerFile(checkout, 'package.json'));
    if (!manifest.scripts?.build) throw new Error('UNSUPPORTED_ACTION_BUILD');
    await producerFile(checkout, 'package-lock.json');
    await producerFile(checkout, 'scripts/metadata.mjs');
    await producerFile(checkout, 'action.yml');
    await invoke('npm', ['ci', '--ignore-scripts']);
    await invoke('npm', ['run', 'build']);
    // Use the producer's YAML parser and validation, not a parallel YAML schema.
    const metadata = await invoke(process.execPath, ['--input-type=module', '-e', [
      "import { readFile } from 'node:fs/promises';",
      "import { actionMetadata } from './scripts/metadata.mjs';",
      "const value = actionMetadata(await readFile('action.yml', 'utf8'));",
      'console.log(JSON.stringify(value.runs));',
    ].join('\n')]);
    const runs = JSON.parse(metadata.stdout);
    if (runs.using !== `node${process.versions.node.split('.')[0]}`) {
      throw new Error('UNSUPPORTED_ACTION_RUNTIME');
    }
    return { entry: await producerFile(checkout, runs.main) };
  }
  if (id === 'cli') {
    await producerFile(checkout, 'go.mod');
    // Go reads the producer's go/toolchain declarations; do not override them.
    const name = process.platform === 'win32' ? 'gh-nibfin.exe' : 'gh-nibfin';
    await invoke('go', ['build', '-trimpath', '-o', name, '.']);
    return { entry: await producerFile(checkout, name) };
  }
  throw new Error('UNSUPPORTED_PRODUCER');
}
