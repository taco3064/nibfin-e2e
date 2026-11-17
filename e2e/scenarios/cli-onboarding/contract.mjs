import assert from 'node:assert/strict';
import { executeNative, nativeCases, requiredManagedCases } from './native.mjs';
import { exerciseContinuity, continuityCases } from './continuity.mjs';
import { exerciseDeliveryContinuity, deliveryCases } from './delivery-continuity.mjs';

export function prerequisite({ sources }) {
  return sources?.core?.checkout && sources?.action?.checkout &&
    sources?.cli?.checkout && sources?.cli?.output?.entry ? true :
    'Prepared current-main CLI source and compatible producer outputs are required';
}
export async function run(context) {
  const actual = await executeNative(context);
  return { ...actual, continuity: await exerciseContinuity(context.sources),
    delivery: await exerciseDeliveryContinuity(context.sources.core) };
}
export function verify(actual) {
  assert.equal(actual.evidence, 'synthetic');
  for (const name of [...nativeCases, ...requiredManagedCases])
    assert.ok(actual.passed.includes(name));
  assert.equal(actual.continuity.evidence, 'synthetic');
  assert.deepEqual(actual.continuity.passed, continuityCases);
  assert.equal(actual.delivery.evidence, 'synthetic');
  assert.deepEqual(actual.delivery.passed, deliveryCases);
  // This confirms the credential-free contract only, never live installation.
  return true;
}
