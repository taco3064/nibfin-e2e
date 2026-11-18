import { mkdtemp, mkdir, writeFile, rm, readdir, readFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sourceRepositories } from './source-checkout.mjs';
import { sourceCommand, sourceTerminationUnknown } from './source-process.mjs';
import { javascriptRequests } from './delivery-fixtures.mjs';
import { assertMergedJavaScript } from './delivery-javascript.mjs';

// Fixed compatibility declarations are local fixtures, never acquired producers.
export function simulatedSourceDefinition(root, ownershipId) {
  const sources = Object.fromEntries(sourceRepositories.map((source, index) =>
    [source.id, { ...source, commit: String(index + 1).repeat(40),
      checkout: join(root, source.id), output: {} }]));
  const pin = { repository: sources.core.repository, commit: sources.core.commit,
    archiveHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64) };
  sources.core.output.pin = pin;
  sources.cli.output.entry = join(root, 'cli', 'gh-nibfin');
  return { root, sources, ownershipId, disposed: false };
}

export async function simulatedSources(root) {
  const prepared = simulatedSourceDefinition(root, `simulated-${randomUUID()}`);
  const { sources } = prepared;
  const pin = sources.core.output.pin;
  await mkdir(join(sources.cli.checkout, 'internal/cli'), { recursive: true });
  await mkdir(sources.action.checkout, { recursive: true });
  await writeFile(join(sources.action.checkout, 'core-source.json'),
    JSON.stringify(pin));
  await writeFile(join(sources.cli.checkout, 'internal/cli/producers.json'),
    JSON.stringify({ core: pin, action: sources.action }));
  return prepared;
}

async function treeFiles(root, prefix = '') {
  const files = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...await treeFiles(root, path));
    else files.push(path);
  }
  return files;
}

// Simulated Git metadata comes from the provider's merge, with no Git index or
// repository metadata constructed. The maintained assertion executes real Node.
export async function simulatedSourceAssertion(provider, leg, binding, signal) {
  const program = javascriptRequests.find(item =>
    leg.binding.path === `${leg.definition.generatedRoot}${item.path}`);
  if (!program || leg.merged?.content !== program.content ||
      leg.binding.content !== program.content ||
      !/^fixtures\/generated\/[a-f0-9-]{36}\/$/.test(leg.definition.generatedRoot)) {
    return { ...binding, state: 'contradicted' };
  }
  const pull = provider.observe({ kind: 'pull', repository: binding.repository,
    number: leg.evidence.pull.number }).data;
  if (!pull.merged || pull.merge_commit_sha !== binding.mergeCommit ||
      leg.binding.repository !== binding.repository ||
      leg.issue !== binding.issue || leg.merged?.commit !== binding.mergeCommit) {
    return { ...binding, state: 'contradicted' };
  }
  let root;
  provider.begin();
  let known = true;
  try {
    const result = await assertMergedJavaScript(binding, async () => {
      root = await mkdtemp(join(tmpdir(), 'nibfin-simulated-merge-'));
      provider.localResources.set(root, { root, terminated: false });
      const file = join(root, leg.binding.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, leg.merged.content);
      return { root, dispose: () => rm(root, { recursive: true, force: true }) };
    }, signal, async (file, args, settings) => {
      if (file === 'git') {
        if (JSON.stringify(args) ===
            JSON.stringify(['rev-parse', '--verify', 'HEAD^{commit}'])) {
          return { stdout: `${leg.merged.commit}\n` };
        }
        if (JSON.stringify(args) === JSON.stringify([
          'status', '--porcelain', '--untracked-files=all',
        ])) {
          const files = await treeFiles(root);
          const clean = files.length === 1 && files[0] === leg.binding.path &&
            await readFile(join(root, files[0]), 'utf8') === leg.merged.content;
          return { stdout: clean ? '' : 'dirty\n' };
        }
      }
      if (file !== process.execPath || args.length !== 1 ||
          args[0] !== join(root, leg.binding.path)) provider.network();
      try { return await sourceCommand(file, args, settings); }
      catch (error) {
        known = !sourceTerminationUnknown(error);
        throw error;
      }
    });
    provider.sourceResult(binding.repository, binding.issue, result.state);
    return result;
  } finally {
    provider.end(known);
    if (root && known) {
      await rm(root, { recursive: true, force: true });
      provider.localResources.delete(root);
    }
  }
}
