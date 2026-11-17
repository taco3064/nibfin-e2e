import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createSimulatedSuite } from '../simulated-suite.mjs';
import { claudeDelivery } from './claude-delivery-composition.mjs';
import { deliveryControls } from './claude-delivery-controls.mjs';
import { environment } from './isolation-common.mjs';
export { claudeDelivery } from './claude-delivery-composition.mjs';
export { prerequisite } from './isolation-common.mjs';

export async function run(context) {
  const delivery = await claudeDelivery(context);
  const suite = await createSimulatedSuite({ delivery });
  try {
    const request = { runId: 'claude-controlled' };
    await suite.run({ ...request, phase: 'provision' });
    await suite.run({ ...request, phase: 'install', resume: true });
    const result = await suite.run({ ...request, phase: 'delivery', resume: true });
    assert.equal(result.phases.delivery.state, 'passed');
    assert.equal(result.provenance, 'controlled');
    const legs = [...suite.provider.executions.values()];
    assert.equal(legs.length, 2);
    for (const leg of legs) {
      assert.equal(leg.evidence.applicability.state, 'satisfied');
      assert.equal(leg.progress.attempts.length, 5);
      assert(leg.progress.attempts.every(attempt =>
        attempt.agent.provider === 'claude' && attempt.status === 'success'));
    }
    assert.equal(suite.trace().filter(row => row.operation === 'execute-javascript' &&
      row.outcome === 'satisfied').length, 2);
    return { state: 'passed', mode: 'fixture', liveVerified: false,
      deliveries: legs.length, variants: await deliveryControls(context),
      observation: environment(context, 'synthetic/local') };
  } finally {
    await suite.run({ runId: 'claude-controlled', phase: 'cleanup', resume: true });
    await suite.dispose();
    await assert.rejects(access(delivery.root));
  }
}
export const verify = actual => actual.state === 'passed' &&
  actual.mode === 'fixture' && actual.liveVerified === false && actual.deliveries === 2 &&
  actual.variants === 5;
export const describe = actual => JSON.stringify(actual.observation);
