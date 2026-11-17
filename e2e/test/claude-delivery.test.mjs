import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { run, verify, claudeDelivery } from '../scenarios/claude-delivery.mjs';
import { createSimulatedSuite } from '../simulated-suite.mjs';

const core = process.env.NIBFIN_TEST_CORE;
const commit = process.env.NIBFIN_TEST_CORE_COMMIT;
const context = { sources: { core: { checkout: core, commit,
  repository: 'taco3064/nibfin-core' } } };
const skip = !core || !commit ? 'Prepared Core source and identity required' : false;

test('Claude result requires all component delivery and recovery evidence', () => {
  const actual = { state: 'passed', mode: 'fixture', liveVerified: false,
    deliveries: 2, variants: 5 };
  assert.equal(verify(actual), true);
  for (const key of Object.keys(actual)) {
    const missing = { ...actual };
    delete missing[key];
    assert.equal(verify(missing), false);
  }
  assert.equal(verify({ ...actual, liveVerified: true }), false);
});

test('Claude composition requires separately prepared sources', async () => {
  await assert.rejects(claudeDelivery({}), /PREPARED_CORE_REQUIRED/);
});

test('prepared Claude adapter delivery and negative variants', { skip }, async () => {
  const actual = await run(context);
  assert.equal(verify(actual), true);
  const publicResult = JSON.stringify(actual);
  for (const secret of [core, 'sessionId', 'executionId', 'sk-ant-',
    'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'private-runner']) {
    assert(!publicResult.includes(secret));
  }
});

test('Claude role chains outlive the ordinary request bound and clean up', { skip },
  async () => {
    const delivery = await claudeDelivery(context);
    let delayed = false;
    const suite = await createSimulatedSuite({ delivery: { ...delivery,
      async advance(...args) {
        // A settled multi-role request can legitimately exceed the ordinary
        // five-second bound even though each model process remains bounded.
        if (!delayed) {
          delayed = true;
          await setTimeout(5500);
        }
        return delivery.advance(...args);
      },
    } });
    const request = { runId: 'claude-bounded' };
    try {
      await suite.run({ ...request, phase: 'provision' });
      await suite.run({ ...request, phase: 'install', resume: true });
      const result = await suite.run({ ...request, phase: 'delivery', resume: true });
      assert.equal(result.phases.delivery.state, 'passed');
      assert.equal(suite.provider.executions.size, 2);
      assert.equal(delivery.pending, 0);
    } finally {
      const cleanup = await suite.run({ ...request, phase: 'cleanup', resume: true });
      assert.equal(cleanup.cleanup, 'complete');
      await suite.dispose();
      await assert.rejects(access(suite.root));
      await assert.rejects(access(delivery.root));
    }
  });

test('conflicting shared slot rejects Claude roles before publication', { skip },
  async () => {
    const delivery = await claudeDelivery(context);
    const suite = await createSimulatedSuite({ delivery });
    const request = { runId: 'claude-conflict' };
    try {
      await suite.run({ ...request, phase: 'provision' });
      await suite.run({ ...request, phase: 'install', resume: true });
      const slots = [...suite.provider.registrations.values()];
      assert(slots.every(slot => slot.agent.provider === 'claude'));
      slots[1].agent.provider = 'codex';
      const result = await suite.run({ ...request, phase: 'delivery', resume: true });
      assert.equal(result.phases.delivery.state, 'unresolved');
      assert.equal(suite.provider.executions.size, 0);
      assert(!suite.trace().some(row => row.resource?.kind === 'pull'));
      for (const phase of suite.provider.phases.values()) {
        assert(phase.legs.every(leg => !leg.progress));
      }
    } finally {
      assert.equal(delivery.pending, 0);
      suite.provider.pending.clear();
      await suite.run({ ...request, phase: 'cleanup', resume: true });
      await suite.dispose();
      await assert.rejects(access(delivery.root));
    }
  });
