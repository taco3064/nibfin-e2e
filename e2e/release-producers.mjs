import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { producerFile, verifyCompatibility } from './source-producers.mjs';
import { sourceCommand } from './source-process.mjs';
import { sourceIdentities, validateVersion } from './release-contract.mjs';

async function requireAbsent(path) {
  try { await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('RELEASE_STAGING_EXISTS');
}

// Invocation only. The caller must validate the complete staged set before any
// readiness handoff. Raw producer results are not release-readiness evidence.
export async function invokeReleaseProducers(sources, version, context) {
  validateVersion([version]);
  sourceIdentities(sources);
  await verifyCompatibility(sources, sources.core.output);
  const { command = sourceCommand, env, root } = context;
  const coreEntry = await producerFile(
    sources.core.checkout, 'bin/nibfin-core-release.mjs',
  );
  const actionEntry = await producerFile(
    sources.action.checkout, 'scripts/release.mjs',
  );
  await producerFile(sources.cli.checkout, 'scripts/release/main.go');
  const output = join(root, 'release-core');
  await requireAbsent(output);
  await requireAbsent(join(sources.cli.checkout, 'dist'));
  const invoke = async (source, file, args) => {
    const result = await command(file, args, { cwd: source.checkout, env });
    if (result.stderr) context.diagnostic?.(result.stderr);
    return result;
  };
  // Use only the acquired worktrees. No cloning, source commits, tags or remote
  // writes belong here. Products own packaging, tool selection and metadata.
  const core = await invoke(sources.core, process.execPath,
    [coreEntry, sources.core.checkout, version, output]);
  const action = await invoke(sources.action, process.execPath,
    [actionEntry, version]);
  const cli = await invoke(sources.cli, 'go',
    ['run', './scripts/release', '--version', version]);
  return { core, action, cli, coreDirectory: output };
}
