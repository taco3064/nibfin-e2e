import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = new URL(import.meta.url).searchParams.get('mode');
export async function prerequisite() {
  return mode === 'blocked' ? 'Local prerequisite is absent' : true;
}
export async function run({ tempDir }) {
  console.log('fixture diagnostics');
  await writeFile(join(tempDir, 'owned.txt'), 'fixture');
  if (mode === 'throw') throw new Error('execution failed');
  if (mode === 'reject') return Promise.reject(new Error('execution rejected'));
  if (mode === 'exit') process.exit(0);
  if (mode === 'busy') { while (true) { /* Noncooperative execution. */ } }
  if (mode === 'timeout') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await writeFile(join(tempDir, 'late.txt'), 'late completion');
  }
  if (mode === 'timer') {
    setInterval(() => { void writeFile(join(tempDir, 'late.txt'), 'late'); }, 20);
  }
  return tempDir;
}
export async function verify(actual, { tempDir }) {
  if (mode === 'assert') assert.fail('required assertion failed');
  if (mode === 'assert-timeout') {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (mode === 'unverified') return undefined;
  assert.equal(actual, tempDir);
  return true;
}
