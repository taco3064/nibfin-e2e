import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const commits = Object.freeze({
  core: '1'.repeat(40), action: '2'.repeat(40), cli: '3'.repeat(40),
});
export const pin = Object.freeze({
  repository: 'taco3064/nibfin-core', commit: commits.core,
  archiveHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64),
});
export async function put(root, path, value = '') {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'object' ? JSON.stringify(value) : value);
  return target;
}
export function fakeSources(overrides = {}) {
  const requests = [];
  const prepared = [];
  const upstream = { ...commits };
  const acquire = async (source, checkout) => {
    requests.push({ ...source, checkout });
    await mkdir(checkout);
    if (source.id === 'core') {
      await put(checkout, 'scripts/package-ci.mjs');
    }
    if (source.id === 'action') {
      await put(checkout, 'core-source.json', pin);
      await put(checkout, 'package.json', { scripts: { build: 'node check.mjs' } });
      for (const path of ['package-lock.json', 'scripts/metadata.mjs',
        'action.yml', 'src/main.mjs']) await put(checkout, path);
    }
    if (source.id === 'cli') {
      await put(checkout, 'internal/cli/producers.json', {
        core: pin, action: {
          repository: 'taco3064/nibfin-act', commit: upstream.action,
        },
      });
      await put(checkout, 'go.mod', 'module fake\n\ngo 1.27.1\n');
    }
    return upstream[source.id];
  };
  const prepare = async source => {
    prepared.push(source.id);
    const entry = await put(source.checkout, 'output', source.commit);
    return source.id === 'core' ? { archive: entry, pin } : { entry };
  };
  return { requests, prepared, upstream, acquire, prepare, ...overrides };
}
