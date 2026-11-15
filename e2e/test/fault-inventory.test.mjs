import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture-support.mjs';
import { faultFixture } from './fault-support.mjs';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { runLifecycle } from '../lifecycle.mjs';

for (const state of ['intent', 'restore-intent', 'recover-intent', 'repeat-intent',
  'observed', 'restored']) {
  test(`independent teardown preserves unresolved fault ${state}`, async t => {
    const f = await fixture(t);
    await f.lifecycle().setup('issue');
    await f.inventory.exclusive(async (ledger, save) => {
      ledger.faultExecution = { state, binding: { case: 'unknown-write' } };
      await save();
    });
    const result = await f.lifecycle().teardown();
    assert.equal(result.state, 'unverified');
    assert.deepEqual(f.writes, [['create', 'issue']]);
    await f.inventory.exclusive(async (ledger, save) => {
      ledger.faultExecution.state = 'completed';
      await save();
    });
    assert.equal((await f.lifecycle().teardown()).state, 'passing');
  });
}

test('unknown fault intent survives reopening the real durable inventory', async t => {
  const root = await fixture(t);
  const f = faultFixture();
  const create = f.caller.createFixture;
  const inventories = [];
  f.caller.createFixture = async definition => {
    const owned = await create(definition);
    const inventory = await fixtureInventory(join(root.root, 'fault-ledgers'),
      definition, 7, join(root.root, 'fault-worker'));
    inventories.push({ inventory, definition });
    return { ...owned, inventory };
  };
  f.caller.applyFault = async binding => {
    const saved = JSON.parse(await readFile(inventories[0].inventory.path, 'utf8'));
    assert.equal(saved.faultExecution.binding.operationId, binding.operationId);
    assert.equal(saved.faultExecution.state, 'intent');
    throw new Error('Unknown native effect');
  };
  const result = await runLifecycle({ repository: 'fixture/repository',
    assignee: { id: 7, login: 'target-actor' }, case: 'unknown-write' }, f.caller);
  assert.equal(result.cleanup, 'unresolved');
  const reopened = await fixtureInventory(join(root.root, 'fault-ledgers'),
    inventories[0].definition, 7, join(root.root, 'fault-worker'));
  await reopened.exclusive(async ledger => {
    assert.equal(ledger.faultExecution.state, 'intent');
    assert.equal(ledger.faultExecution.binding.case, 'unknown-write');
  });
  assert.equal(f.events.some(event => event.startsWith('cleanup')), false);
});
