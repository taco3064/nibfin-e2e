import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Metadata only. Native registration/service/effect records stay separate from
// CLI result documents and are covered by the existing exclusive fixture lock.
export const initialReplacement = () => ({
  old: [25, 26], fresh: [], repositories: [10, 11], recovery: 'pending',
});

export async function replacementObservation(root) {
  const value = JSON.parse(await readFile(join(root, 'home',
    'replacement-observations.json'), 'utf8'));
  assert.deepEqual(Object.keys(value).sort(),
    ['fresh', 'old', 'provider', 'recovery', 'removals', 'repositories',
      'retirementId']);
  assert.deepEqual(value.old, [25, 26]);
  assert.deepEqual(value.removals, value.old);
  assert.deepEqual(value.repositories, [10, 11]);
  assert.equal(value.recovery, 'reconstructed');
  assert.equal(value.provider, 'claude');
  assert.match(value.retirementId, /^[a-f0-9-]{36}$/);
  assert.equal(value.fresh.length, 2);
  assert.equal(new Set([...value.old, ...value.fresh]).size, 4);
  assert(value.fresh.every(id => Number.isSafeInteger(id) && id > 0));
  return value;
}
