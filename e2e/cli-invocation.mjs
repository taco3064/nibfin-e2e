import { protectedSharedInstallation } from './scenarios/cli-onboarding/installation.mjs';

// Imported only by trusted composition, never resolved from worker context or data.
export function protectedCliInvocation(options = {}) {
  const required = ['authorize', 'observe', 'command', 'reconcile'];
  if (!options.sources || !options.run ||
      !['synthetic', 'operator'].includes(options.context?.origin) ||
      typeof options.inventory?.path !== 'string' ||
      typeof options.inventory?.exclusive !== 'function' ||
      typeof options.context?.credentials?.capabilities !== 'function' ||
      required.some(key => typeof options.context?.[key] !== 'function')) {
    return Object.freeze({ run: async () => ({ disposition: 'prerequisite',
      evidence: 'unverified', reason: 'protected-cli-invocation-required' }) });
  }
  const driver = protectedSharedInstallation({ ...options,
    invocationRun: { runId: options.run.runId, attempt: options.run.attempt } });
  return Object.freeze({ run: () => driver.install() });
}
