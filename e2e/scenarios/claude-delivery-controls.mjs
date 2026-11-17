import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createSimulatedSuite } from '../simulated-suite.mjs';
import { claudeDelivery } from './claude-delivery-composition.mjs';

const request = { runId: 'claude-variants' };
const selected = phase => ({ ...request, phase, resume: true });

// These are controlled settlement/authorization observations. They establish no
// provider or production recovery capability. No old conversation is resumed.
export async function deliveryControls(context) {
  for (const mode of ['invalid', 'timeout', 'interrupted', 'unknown']) {
    let injected = false, authorized = false, settled = false;
    const delivery = await claudeDelivery(context, {
      variant(stage) {
        if (stage !== 'deliver' || injected) return 'success';
        injected = true;
        return mode;
      },
      authorizeContinuation: () => authorized,
      settlementConfirmed: () => settled,
    });
    let suite = await createSimulatedSuite({ delivery });
    try {
      await suite.run({ ...request, phase: 'provision' });
      await suite.run(selected('install'));
      const result = await suite.run(selected('delivery'));
      assert.equal(result.phases.delivery.state, 'unresolved');
      let legs = [...suite.provider.phases.values()][0].legs;
      const p = legs[0].progress;
      assert.deepEqual(p.completed, ['shape', 'validate-shape', 'publish-shape']);
      assert.equal(p.attempts.length, 3);
      assert.equal(p.attempts.at(-1).status,
        ['invalid', 'timeout'].includes(mode) ? 'failed' : mode);
      assert.equal(p.context.receipts.deliver, undefined);
      assert.equal(suite.provider.executions.size, 0);
      assert(!suite.trace().some(row => row.resource?.kind === 'pull'));
      const before = structuredClone(p.attempts);
      const trace = suite.trace().filter(row => row.operation === 'trigger').length;
      suite = await suite.restart();
      const pending = await suite.run(selected('delivery'));
      assert.equal(pending.phases.delivery.state, 'unresolved');
      legs = [...suite.provider.phases.values()][0].legs;
      assert.deepEqual(legs[0].progress.attempts, before);
      authorized = true;
      if (['interrupted', 'unknown'].includes(mode)) {
        legs[0].progress.agent.provider = 'codex';
        const conflict = await suite.run(selected('delivery'));
        assert.equal(conflict.phases.delivery.state, 'unresolved');
        assert.deepEqual(legs[0].progress.attempts, before);
        legs[0].progress.agent.provider = 'claude';
      }
      if (mode === 'unknown') {
        const unresolved = await suite.run(selected('delivery'));
        assert.equal(unresolved.phases.delivery.state, 'unresolved');
        assert.equal(delivery.pending, 1);
        assert.deepEqual(legs[0].progress.attempts, before);
        await access(delivery.root);
        await assert.rejects(suite.dispose(), /SIM_DISPOSAL_UNSAFE/);
        settled = true;
      }
      const resumed = await suite.run(selected('delivery'));
      if (['invalid', 'timeout'].includes(mode)) {
        assert.equal(resumed.phases.delivery.state, 'unresolved');
        assert.deepEqual(legs[0].progress.attempts, before);
      } else {
        assert.equal(resumed.phases.delivery.state, 'passed', JSON.stringify(resumed));
        const attempts = legs[0].progress.attempts;
        assert.equal(attempts.length, 6);
        assert.equal(attempts[3].stage, 'deliver');
        assert.notEqual(attempts[3].execution.id, before[2].execution.id);
        assert.notEqual(attempts[3].execution.sessionId, before[2].execution.sessionId);
        assert.deepEqual(attempts.slice(0, 3), before);
        assert.equal(suite.provider.executions.size, 2);
        assert.equal(delivery.pending, 0);
        const repeat = await suite.run(selected('delivery'));
        assert.equal(repeat.phases.delivery.state, 'passed');
        assert.equal(attempts.length, 6);
      }
      assert.equal(suite.trace().filter(row => row.operation === 'trigger').length,
        trace);
    } finally {
      // Failed structured output and a known settled timeout keep retry fenced.
      // The fixture owner can still tear down after independent settlement; this
      // never creates a success receipt or permits another role attempt.
      assert.equal(delivery.pending, 0);
      for (const key of suite.provider.pending) {
        assert(key.startsWith('claude-stage:'));
        suite.provider.pending.delete(key);
      }
      const cleanup = await suite.run(selected('cleanup'));
      assert.equal(cleanup.cleanup, 'complete');
      await suite.dispose();
      await assert.rejects(access(suite.root));
      await assert.rejects(access(delivery.root));
    }
  }
  await lostReply(context);
  return 5;
}


async function lostReply(context) {
  const delivery = await claudeDelivery(context);
  let triggers = 0;
  let suite = await createSimulatedSuite({ delivery, controls: {
    dropReply: operation => operation === 'trigger' && ++triggers === 2,
  } });
  try {
    await suite.run({ ...request, phase: 'provision' });
    await suite.run(selected('install'));
    const result = await suite.run(selected('delivery'));
    assert.equal(result.phases.delivery.state, 'unresolved');
    assert.equal(suite.provider.executions.size, 2);
    assert.equal(suite.provider.pending.size, 1);
    const before = [...suite.provider.executions.values()].map(leg =>
      structuredClone(leg.progress));
    const publications = suite.trace().filter(row => row.resource?.kind === 'pull');
    assert.equal(publications.length, 2);
    await assert.rejects(suite.dispose(), /SIM_DISPOSAL_UNSAFE/);
    suite = await suite.restart();
    const reconciled = await suite.run(selected('delivery'));
    assert.equal(reconciled.phases.delivery.state, 'passed');
    assert.deepEqual([...suite.provider.executions.values()].map(leg => leg.progress),
      before);
    assert.deepEqual(suite.trace().filter(row => row.resource?.kind === 'pull'),
      publications);
    assert.equal(suite.provider.executions.size, 2);
    assert.equal(suite.provider.pending.size, 0);
  } finally {
    await suite.run(selected('cleanup'));
    await suite.dispose();
    await assert.rejects(access(delivery.root));
  }
}
