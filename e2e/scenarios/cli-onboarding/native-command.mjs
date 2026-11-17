import { exerciseReplacement } from './replacement.mjs';
import { join } from 'node:path';
import { sourceCommand } from '../../source-process.mjs';
import { sourceEnvironment } from '../../source-checkout.mjs';

export const managedCases = Object.freeze([
  'TestE2EManagedPreview', 'TestE2EManagedProposalReadback',
  'TestE2EManagedCredentialBoundary', 'TestE2EManagedResumeAndPeer',
  'TestE2EManagedUnresolvedEffects',
]);

export const managedResumeCase = 'TestManagedResumeUsesDurableIntentAndControlledHost';

// Fixed operation: the worker cannot choose an executable, arguments, environment
// or provider capability. Parent ownership survives worker termination.
export async function invokeNative(tempDir, signal, core) {
  const root = join(tempDir, 'cli-contract');
  const result = await sourceCommand('go', [
    'test', '-json', '-count=1', '-parallel=1', '-timeout=90s',
    './internal/cli', '-run', `^(TestE2E|${managedResumeCase}$)`,
  ], {
    cwd: join(root, 'source'), timeoutMs: 120000, signal,
    env: {
      ...sourceEnvironment(root), HOME: join(root, 'home'),
      GOCACHE: join(root, 'go-cache'), GOPATH: join(root, 'go-path'),
      XDG_CACHE_HOME: join(root, 'cache'), GH_CONFIG_DIR: join(root, 'gh'),
    },
  });
  const replacement = await exerciseReplacement({ tempDir, sources: { core } }, signal);
  return { ...result, replacement };
}

export function nativeFailure(error) {
  let detail = error.stdout ?? '';
  try {
    const events = detail.trim().split('\n').map(line => JSON.parse(line));
    const failed = new Set(events.filter(event => event.Action === 'fail')
      .map(event => event.Test));
    detail = events.filter(event => event.Action === 'fail' ||
      (event.Output && failed.has(event.Test)))
      .map(event => event.Output ?? `Failed: ${event.Test ?? event.Package}`)
      .join('\n');
  } catch { /* Non-JSON build diagnostics remain visible. */ }
  return `CLI_CONTRACT_FAILED: ${error}; ${detail}`;
}
