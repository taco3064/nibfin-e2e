import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceCommand } from './source-process.mjs';
import { invokeReleaseProducers } from './release-producers.mjs';
import { validateReleaseStaging } from './release-staging.mjs';

const metadataFiles = ['package.json', 'package-lock.json'];
function withoutVersion(value, lock) {
  const copy = structuredClone(value);
  delete copy.version;
  if (lock) delete copy.packages[''].version;
  return JSON.stringify(copy);
}

// This function is called only by the retained source owner after mandatory E2E.
// The returned value is deliberately empty: staged paths never form a reusable
// serialized readiness result, and all outputs remain inside the owned root.
export async function prepareRelease(sources, version, context) {
  const bounded = { ...context, command: context.command ?? sourceCommand };
  const git = async (source, args) => (await bounded.command('git', args, {
    cwd: source.checkout, env: bounded.env,
  })).stdout.trim();
  const check = async (source, after) => {
    if (await git(source, ['rev-parse', '--verify', 'HEAD^{commit}']) !==
        source.commit) throw new Error('RELEASE: source commit changed');
    const untracked = await git(source, ['ls-files', '--others', '--exclude-standard']);
    if (untracked && untracked.split('\n').some(path =>
      source.id !== 'cli' || !path.startsWith('nibfin-e2e-runner-contract/'))) {
      throw new Error('RELEASE: unexpected untracked source');
    }
    const changed = await git(source, ['diff', 'HEAD', '--name-only']);
    const allowed = after && source.id === 'action' ? metadataFiles : [];
    if (changed && changed.split('\n').some(path => !allowed.includes(path))) {
      throw new Error('RELEASE: maintained source changed');
    }
  };
  for (const source of Object.values(sources)) await check(source, false);
  const action = sources.action.checkout;
  const before = await Promise.all(metadataFiles.map(async path =>
    JSON.parse(await readFile(join(action, path), 'utf8'))));
  const staged = await invokeReleaseProducers(sources, version, bounded);
  await validateReleaseStaging(sources, version, staged, bounded);
  for (const source of Object.values(sources)) await check(source, true);
  for (const [index, path] of metadataFiles.entries()) {
    const after = JSON.parse(await readFile(join(action, path), 'utf8'));
    if (withoutVersion(before[index], index === 1) !==
        withoutVersion(after, index === 1)) {
      throw new Error('RELEASE: Action metadata changed beyond version');
    }
  }
}
