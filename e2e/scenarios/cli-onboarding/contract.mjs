import assert from 'node:assert/strict';
import { executeNative, nativeCases } from './native.mjs';

export function prerequisite({ sources }) {
  return sources?.cli?.checkout && sources?.cli?.output?.entry ? true :
    'Prepared current-main CLI source and compatible producer outputs are required';
}
export const run = executeNative;
export function verify(actual) {
  assert.equal(actual.evidence, 'synthetic');
  for (const name of nativeCases) assert.ok(actual.passed.includes(name));
  // This confirms the credential-free contract only, never live installation.
  return true;
}
