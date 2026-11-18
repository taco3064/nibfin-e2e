import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { runIntegration } from './native.mjs';
import { nativeCases } from './cases.mjs';

export async function prerequisite({ sources }) {
  if (process.platform === 'win32') {
    return 'Dashboard native checks require maintained process-group ownership';
  }
  if (!sources?.core?.checkout || !sources?.cli?.checkout) {
    return 'Compatible prepared Core and CLI sources are required';
  }
  try {
    for (const path of ['src/local-work-observation.mjs', 'src/diagnosis-request.mjs',
      'test/local-work-fixture.mjs']) await access(join(sources.core.checkout, path));
    await access(join(sources.cli.checkout, 'internal/cli/dashboard_diagnosis.go'));
    return true;
  } catch {
    return 'Prepared sources lack maintained Dashboard integration fixture capabilities';
  }
}
export const run = runIntegration;
export function verify(actual) {
  if (actual.unavailable) return false;
  assert.equal(actual.evidence, 'controlled Core/CLI regression');
  for (const name of nativeCases) assert.ok(actual.passed.includes(name));
  return true;
}
export const describe = actual => actual.unavailable ??
  'Controlled external observations; not live host or release certification';
