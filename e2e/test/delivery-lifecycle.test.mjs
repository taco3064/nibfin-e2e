import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { fixtureLifecycle } from '../fixture-lifecycle.mjs';
import { runDelivery } from '../delivery-protected.mjs';
import { execute } from '../execution.mjs';
import { scenarios } from '../registry.mjs';
import { protectedFixture } from './delivery-support.mjs';

const request = { repository: 'fixture/repository', path: 'answer.mjs',
  content: 'export const answer = () => 42;\n' };

test('delivery uses durable owned setup, mutation and conservative teardown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = protectedFixture();
  const writes = [];
  let native;
  fixture.caller.createFixture = async definition => {
    const inventory = await fixtureInventory(join(root, 'ledger'), definition, 7,
      join(root, 'worker'));
    return { definition, lifecycle: fixtureLifecycle({ inventory,
      context: { authorize: async () => true, idle: async () => true },
      provider: () => ({
        preflight: async () => 7,
        beforeCreate: async () => {},
        async create(record) {
          writes.push('create');
          native = { id: 10, number: 29, user: { id: 7 }, state: 'open',
            body: record.payload.body,
            url: `https://api.github.com/repos/${definition.repository}/issues/29` };
          return structuredClone(native);
        },
        read: async () => structuredClone(native),
        async mutateIssue(record) {
          writes.push('mutate');
          assert.ok(record.mutation.body.includes(definition.generatedRoot));
          native.body = record.mutation.body;
        },
        async cleanup() { writes.push('close'); native.state = 'closed'; },
      }),
    }) };
  };
  const result = await runDelivery(request, fixture.caller);
  assert.equal(result.state, 'passed');
  assert.equal(result.liveVerified, false);
  assert.deepEqual(writes, ['create', 'mutate', 'close']);
  assert.equal(native.state, 'closed');
});

test('ordinary worker reports specific missing protected capabilities', async () => {
  const entry = scenarios.find(item => item.id === 'delivery.live');
  const result = await execute(entry);
  assert.equal(result.outcome, 'blocked');
  assert.match(result.reason.message, /Protected delivery caller.*receipt reader/);
});

test('unknown effects retain the first failure when cleanup is unresolved', async () => {
  const fixture = protectedFixture();
  const create = fixture.caller.createFixture;
  fixture.caller.createFixture = async definition => {
    const owned = await create(definition);
    owned.lifecycle.teardown = async () => ({ state: 'unverified' });
    return owned;
  };
  let calls = 0;
  fixture.caller.trigger = async () => { calls++; throw new Error('private'); };
  const result = await runDelivery(request, fixture.caller);
  assert.equal(result.code, 'TRIGGER_EFFECT_UNKNOWN');
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(result.state, 'unverified');
  assert.equal(calls, 1);
});

test('bounded observation timeout cannot promote a delivery pass', async () => {
  const fixture = protectedFixture();
  fixture.caller.readDeliveryEvidence = () => new Promise(() => {});
  const result = await runDelivery(request, fixture.caller,
    { requestTimeoutMs: 20, timeoutMs: 1000 });
  assert.equal(result.code, 'STAGES_UNAVAILABLE');
  assert.equal(result.state, 'unverified');
  assert.equal(fixture.counts().cleanups, 1);
});

test('prepared source ownership waits for native idle cleanup', async () => {
  const { withDeliverySources } = await import('../delivery-sources.mjs');
  for (const unresolved of [false, true]) {
    let disposed = false;
    const result = await withDeliverySources(async prepared => {
      assert.equal(prepared.root, 'protected-root');
      return { state: unresolved ? 'unverified' : 'passed', liveVerified: !unresolved,
        ...(unresolved ? { cleanup: 'unresolved' } : {}) };
    }, async () => ({ root: 'protected-root',
      dispose: async () => { disposed = true; } }));
    assert.equal(disposed, !unresolved);
    assert.equal(result.sourceCleanup, unresolved ? 'deferred' : undefined);
  }
  const result = await withDeliverySources(async () => ({ state: 'passed',
    liveVerified: true }), async () => ({
    dispose: async () => { throw new Error('private path'); },
  }));
  assert.equal(result.state, 'unverified');
  assert.equal(result.liveVerified, false);
  assert.equal(result.sourceCleanup, 'unresolved');
  assert.equal(JSON.stringify(result).includes('private path'), false);
});
