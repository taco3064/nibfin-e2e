import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceCommand, sourceTerminationUnknown } from './source-process.mjs';
import { operatorModel } from './operator-model.mjs';
import { rejectManagedProvider } from './operator-config.mjs';
import { claudeFlags } from './operator-claude.mjs';

// A bounded authenticated structured request proves more than a cached login.
// No investigation evidence, Scope checkout or publication credential is used.
export async function operatorReadiness(config, command = sourceCommand) {
  const agent = config.agent;
  const executable = config[`${agent}Executable`];
  let help;
  let root;
  let unknown = false;
  try {
    if (command === sourceCommand) await rejectManagedProvider(agent);
    root = await mkdtemp(join(config.scratchRoot, 'readiness-'));
    help = await command(executable, agent === 'codex' ?
      ['exec', '--help'] : ['--bare', '--help'], {
      cwd: root,
      env: { HOME: root, CODEX_HOME: join(root, 'config'),
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeoutMs: 10000, limit: 128000,
    });
  } catch (error) {
    unknown = sourceTerminationUnknown(error);
    throw new Error(error.code === 'ENOENT' ? 'OPERATOR_AGENT_UNAVAILABLE' :
      'OPERATOR_AGENT_INCOMPATIBLE', { cause: error });
  }
  finally {
    if (root && !unknown) await rm(root, { recursive: true, force: true });
  }
  const flags = agent === 'claude' ? claudeFlags : ['--strict-config',
    '--ignore-user-config', '--ignore-rules', '--ephemeral', '--output-schema'];
  if (!flags.every(flag => help.stdout.includes(flag))) {
    throw new Error('OPERATOR_AGENT_INCOMPATIBLE');
  }
  try {
    const result = await operatorModel(config, command)({
      task: 'Readiness check only. Return {"ready":true}.',
    }, { type: 'object', additionalProperties: false, required: ['ready'],
      properties: { ready: { type: 'boolean', const: true } } },
    AbortSignal.timeout(30000));
    if (result?.ready !== true || Object.keys(result).length !== 1) {
      throw new Error('OPERATOR_MODEL_READINESS');
    }
  } catch (error) {
    // Keep termination evidence for protected recovery, never raw diagnostics.
    const safe = new Error('OPERATOR_AGENT_AUTHENTICATION');
    safe.terminationUnknown = sourceTerminationUnknown(error);
    throw safe;
  }
}
