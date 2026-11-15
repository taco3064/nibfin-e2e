import { readFile, realpath, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { sourceCommand, sourceTerminationUnknown } from './source-process.mjs';
import { sourceEnvironment } from './source-checkout.mjs';
import { validRequest } from './delivery-contract.mjs';

// checkoutMerge is an existing protected acquisition capability. It must create
// a disposable checkout of this repository/commit, never the writer workspace.
// Native Git reads independently establish the commit and clean checkout.
export async function assertMergedJavaScript(binding, checkoutMerge, signal,
  command = sourceCommand) {
  const result = state => ({ ...binding, state });
  if (!validRequest(binding) || !binding.path.endsWith('.mjs') ||
      !/^[a-f0-9]{40}$/.test(binding.mergeCommit ?? '') ||
      typeof binding.stdout !== 'string') return result('unknown');
  let checkout;
  let terminationUnknown = false;
  let outcome = result('unknown');
  try {
    checkout = await checkoutMerge({ repository: binding.repository,
      mergeCommit: binding.mergeCommit }, signal);
    if (typeof checkout?.dispose !== 'function') throw new Error();
    const root = await realpath(checkout.root);
    const options = { cwd: root, env: sourceEnvironment(root), signal,
      timeoutMs: 30000, limit: 65536 };
    const git = args => command('git', args, options);
    const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const status = await git(['status', '--porcelain', '--untracked-files=all']);
    if (head.stdout !== `${binding.mergeCommit}\n` || status.stdout !== '') {
      throw new Error();
    }
    const file = join(root, binding.path);
    const resolved = await realpath(file);
    if (relative(root, resolved) !== binding.path ||
        !(await lstat(file)).isFile()) throw new Error();
    if (await readFile(file, 'utf8') !== binding.content) {
      outcome = result('contradicted');
    } else {
      const execution = await command(process.execPath, [file], options);
      outcome = { ...result(execution.stdout === binding.stdout
        ? 'satisfied' : 'contradicted'), stdout: execution.stdout, exitCode: 0,
      checkout: { commit: binding.mergeCommit, clean: true } };
    }
  } catch (error) {
    terminationUnknown = sourceTerminationUnknown(error);
    // A nonzero execution or unavailable checkout cannot establish success.
    outcome = result('unknown');
  } finally {
    if (checkout && !terminationUnknown) {
      try { await checkout.dispose(); }
      catch { outcome = result('unknown'); }
    }
  }
  return outcome;
}
