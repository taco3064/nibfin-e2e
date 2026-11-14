import assert from 'node:assert/strict';

// Controlled contract fixture only; never registered as live release coverage.
export async function run({ sources }) {
  assert.equal(process.env.NIBFIN_RELEASE_TEST_SECRET, undefined);
  assert.equal(Object.keys(process.env).length, 0);
  assert.deepEqual(Object.keys(sources).sort(), ['action', 'cli', 'core']);
  assert.ok(Object.values(sources).every(source => source.commit === 'a'.repeat(40)));
  return true;
}
export async function verify(actual) {
  return actual === true;
}
