import { fileURLToPath } from 'node:url';
import { sourceCommand } from '../source-process.mjs';

export const prerequisite = ({ sources }) => sources?.core?.checkout ? true :
  'Prepared compatible current-main Core source unavailable';

export async function run({ sources }) {
  const result = await sourceCommand(process.execPath, ['--test',
    '--test-concurrency=1',
    fileURLToPath(new URL('../pause-core-contract.mjs', import.meta.url))], {
    cwd: sources.core.checkout,
    env: { E2E_CORE_ROOT: sources.core.checkout }, timeoutMs: 30000,
  });
  return { mode: 'fixture', liveVerified: false, completed: true,
    source: { repository: sources.core.repository, commit: sources.core.commit },
    diagnostics: result.stdout };
}

export const verify = result => result?.mode === 'fixture' &&
  result.liveVerified === false && result.completed === true;
export const describe = () => 'Controlled actual Core source; live execution unverified';
