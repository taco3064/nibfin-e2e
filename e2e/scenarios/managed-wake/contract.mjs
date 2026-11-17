import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { producerFile } from '../../source-producers.mjs';
import { activate } from './native.mjs';
import { exercise, requiredCases } from './cases.mjs';

export async function prerequisite({ sources }) {
  if (process.platform !== 'linux') {
    return 'Managed activation is unavailable: Linux is required';
  }
  if (!sources?.core?.checkout || !sources?.core?.output?.pin ||
      !sources?.cli?.checkout || !sources?.cli?.output?.entry) {
    return 'Prepared compatible CLI and Core producers are unavailable';
  }
  try {
    await access(sources.cli.output.entry);
    const pins = JSON.parse(await readFile(await producerFile(
      sources.cli.checkout, 'internal/cli/producers.json'), 'utf8'));
    assert.deepEqual(pins.core, sources.core.output.pin);
    assert.equal(pins.core.commit, sources.core.commit);
    await producerFile(sources.cli.checkout, 'internal/cli/managed-relay_linux.go');
    await producerFile(sources.core.checkout, 'src/notification-relay.mjs');
  } catch { return 'Managed producer interfaces are unavailable or incompatible'; }
  return true;
}
export async function run(context) {
  const activation = await activate(context);
  return { evidence: 'synthetic', passed: await exercise(context, activation) };
}
export function verify(actual) {
  assert.equal(actual.evidence, 'synthetic');
  assert.deepEqual(actual.passed, requiredCases);
  return true;
}
export function describe() {
  return 'Controlled activation, hosted artifacts, provider and Runner observations; ' +
    'Shape selection only, never stage execution or live installation certification';
}
