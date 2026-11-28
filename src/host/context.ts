import { join } from 'node:path';
import { NEVER } from '../abort.ts';
import { SANDBOX } from './config.ts';
import { childEnv } from './exec.ts';
import { readClaudeSettings } from './login.ts';
import { createHostOperations } from './operations.ts';
import { setVisibility } from './sandbox.ts';
import type { HostServices } from './services.ts';
import type { HostContext } from '../types.ts';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The host as scenarios see it. */
export function createHostContext(host: HostServices, platform: string = process.platform): HostContext {
  const executionDir = join(host.repoRoot, '.e2e-work', 'sandbox');
  return {
    ...createHostOperations(host, platform),
    sandbox: { ...SANDBOX },
    signal: NEVER,
    executionDir,
    ghNibfin: (args, options = {}) =>
      host.exec(['gh', 'nibfin', ...args], { ...options, cwd: executionDir, ghToken: host.sandboxToken() }),
    gh: (args, options = {}) => host.exec(['gh', ...args], { ...options, ghToken: host.sandboxToken() }),
    workPath: (...parts) => join(host.workDir(), ...parts),
    claudeSettings: async () => (await readClaudeSettings(host.exec)).settings,
    github: host.github,
    startGhNibfin: (args, options = {}) =>
      host.start(['gh', 'nibfin', ...args], { cwd: executionDir, ghToken: host.sandboxToken(), path: options.path }),
    start: (argv) => host.start(argv),
    exec: (argv, options = {}) => host.exec(argv, { cwd: options.cwd, input: options.input, env: options.env }),
    workDir: () => host.workDir(),
    browserEnv: () => childEnv(host.env),
    peer() {
      if (!host.peer)
        throw new Error('the collaborator is not prepared: the collaborator provisioning step did not pass');
      return host.peer;
    },
    async withExecutionVisibility(visibility, fn) {
      await setVisibility(host.github, SANDBOX.execution, visibility);
      let failure: { error: unknown } | undefined;
      let value;
      try {
        value = await fn();
      } catch (error) {
        failure = { error };
      }
      try {
        await setVisibility(host.github, SANDBOX.execution, 'public');
      } catch (error) {
        const also = failure ? `; the scenario had also failed: ${message(failure.error)}` : '';
        throw new Error(`restoring ${SANDBOX.execution} to public failed: ${message(error)}${also}`, { cause: error });
      }
      if (failure) throw failure.error;
      return value as Awaited<ReturnType<typeof fn>>;
    },
  };
}
