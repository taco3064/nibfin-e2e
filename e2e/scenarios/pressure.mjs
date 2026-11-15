import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sourceCommand } from '../source-process.mjs';
import { observePressure, pressureCases } from '../pressure-observations.mjs';
import { pressureFixture } from './pressure-fixtures.mjs';

export function controlledPressureRows() {
  return pressureCases.map(phase => {
    const { binding, evidence } = pressureFixture(phase);
    return { ...observePressure(binding, evidence), phase,
      mode: 'fixture', evidenceLevel: 'synthetic', liveVerified: false };
  });
}
export const prerequisite = ({ sources }) => sources?.core?.checkout ? true :
  'Prepared Core source required for controlled pressure execution';
export async function run({ sources }) {
  const result = await sourceCommand(process.execPath, ['--test',
    '--test-concurrency=1',
    fileURLToPath(new URL('../pressure-core-contract.mjs', import.meta.url)),
    join(sources.core.checkout, 'test/job-vm-exec-relay.test.mjs')], {
    cwd: sources.core.checkout, env: { E2E_CORE_ROOT: sources.core.checkout },
    timeoutMs: 20000,
  });
  return { rows: controlledPressureRows(), coreCompleted: true,
    diagnostics: result.stdout, mode: 'fixture', liveVerified: false };
}
export const verify = result => result.coreCompleted === true &&
  result.rows.length === pressureCases.length && result.rows.every(row =>
    row.mode === 'fixture' && row.liveVerified === false &&
    row.evidenceLevel === 'synthetic' && (row.phase === 'pending'
      ? row.code === 'PENDING_TERMINATION_OR_EFFECTS' : row.state === 'passed'));
export const describe = () => 'Synthetic pressure; actual WSL support unverified';
