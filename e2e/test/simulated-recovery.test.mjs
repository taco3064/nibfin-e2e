import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createSimulatedSuite } from '../simulated-suite.mjs';
import { simulatedProvider } from '../simulated-provider.mjs';

const runId = 'restart-recovery';
const selected = (phase, resume = true) => ({ runId, phase, resume });
const copy = value => structuredClone(value);
const snapshot = f => f.inventory.exclusive(state => copy(state));
const writes = (f, operation) => f.trace().filter(row =>
  row.operation === operation && row.outcome === 'observed');
function lost(operation, occurrence = 1) {
  let count = 0;
  return { dropReply: name => name === operation && ++count === occurrence };
}

async function fixture(t, controls) {
  let current = await createSimulatedSuite({ controls });
  t.after(async () => {
    const state = await snapshot(current);
    if (state.suite) await current.run(selected('cleanup'));
    await current.dispose();
    await assert.rejects(access(current.root), { code: 'ENOENT' });
  });
  return {
    get current() { return current; },
    async restart() {
      const previous = current;
      current = await previous.restart();
      assert.notEqual(current.provider, previous.provider);
      assert.notEqual(current.inventory, previous.inventory);
      assert.equal(current.prepared, previous.prepared);
      await assert.rejects(previous.run(selected('cleanup')), /UNAVAILABLE/);
      await assert.rejects(previous.dispose(), /UNAVAILABLE/);
      // Deliberately erase discarded client memory. The new client must use
      // only its independently retained remote snapshot and durable inventory.
      previous.provider.phases.clear();
      previous.provider.executions.clear();
      previous.provider.repositories.clear();
      previous.provider.pending.clear();
      return current;
    },
  };
}
async function installed(f) {
  await f.run(selected('provision', false));
  const result = await f.run(selected('install'));
  assert.equal(result.phases.install.state, 'passed');
}
function unchanged(before, after, phase) {
  assert.equal(after.suite.runId, before.suite.runId);
  assert.equal(after.suite.sourceOwner, before.suite.sourceOwner);
  assert.deepEqual(after.suite.sources, before.suite.sources);
  assert.deepEqual(after.suite.locations, before.suite.locations);
  assert.equal(after.suite.phases[phase].intent, before.suite.phases[phase].intent);
  assert.equal(after.suite.phases[phase].execution,
    before.suite.phases[phase].execution);
  assert.deepEqual(after.repositories.map(row => [row.repository, row.operation]),
    before.repositories.map(row => [row.repository, row.operation]));
}

test('committed create with lost reply recovers original receipt after restart',
  async t => {
    const fixtureState = await fixture(t, lost('create'));
    let f = fixtureState.current;
    const result = await f.run(selected('provision', false));
    assert.equal(result.outcome, 'non-passing');
    assert.equal(result.phases.provision.state, 'unresolved');
    const before = await snapshot(f);
    const original = before.repositories[0];
    assert.equal(original.creation, 'unresolved');
    assert.equal(original.native, null);
    const native = copy(f.provider.repositories.get(original.repository).native);
    assert.equal(writes(f, 'create').length, 1);
    assert.equal((await f.run(selected('cleanup'))).cleanup, 'pending');
    assert.equal(writes(f, 'remove').length, 0);
    f = await fixtureState.restart();
    const recovered = await f.run(selected('provision'));
    assert.equal(recovered.phases.provision.state, 'passed');
    const after = await snapshot(f);
    unchanged(before, after, 'provision');
    assert.deepEqual(after.repositories[0].native.id, native.id);
    assert.equal(writes(f, 'create').filter(row =>
      row.repository === original.repository).length, 1);
    assert.equal(writes(f, 'create').length, 2);
  });

test('lost second dispatch reply reconciles original executions without replay',
  async t => {
    const fixtureState = await fixture(t, lost('trigger', 2));
    let f = fixtureState.current;
    await installed(f);
    const result = await f.run(selected('delivery'));
    assert.equal(result.outcome, 'non-passing');
    assert.equal(result.phases.delivery.code, 'TRIGGER_EFFECT_UNKNOWN');
    const before = await snapshot(f);
    const identities = [...f.provider.executions.keys()];
    assert.equal(identities.length, 2);
    assert.equal(writes(f, 'trigger').length, 2);
    assert.equal((await f.run(selected('cleanup'))).cleanup, 'pending');
    assert.equal(writes(f, 'remove').length, 0);
    f = await fixtureState.restart();
    // Settlement of another phase cannot authorize this interrupted dispatch.
    const repository = f.provider.definition.repositories[0];
    f.provider.scope(runId, 'failure');
    f.provider.resolve('trigger', repository);
    assert.equal(f.provider.pending.size, 1);
    const recovered = await f.run(selected('delivery'));
    assert.equal(recovered.phases.delivery.state, 'passed', JSON.stringify(recovered));
    unchanged(before, await snapshot(f), 'delivery');
    assert.deepEqual([...f.provider.executions.keys()], identities);
    assert.equal(writes(f, 'trigger').length, 2);
    assert.equal(f.provider.repositories.size, 2);
    assert.equal((await f.run(selected('cleanup'))).cleanup, 'complete');
    assert.equal(writes(f, 'remove').length, 2);
  });

test('lost delete reply reconciles independently verified absence after restart',
  async t => {
    const fixtureState = await fixture(t, lost('remove'));
    let f = fixtureState.current;
    await f.run(selected('provision', false));
    const foreign = { owner: 'unrelated', native: { id: 999 } };
    f.provider.repositories.set('unrelated/repository', foreign);
    const result = await f.run(selected('cleanup'));
    assert.equal(result.cleanup, 'pending');
    const before = await snapshot(f);
    const deleted = before.repositories[0].repository;
    assert.equal(f.provider.repositories.has(deleted), false);
    assert.equal(writes(f, 'remove').length, 1);
    f = await fixtureState.restart();
    const recovered = await f.run(selected('cleanup'));
    assert.equal(recovered.cleanup, 'complete', JSON.stringify(recovered));
    const after = await snapshot(f);
    unchanged(before, after, 'cleanup');
    assert.equal(writes(f, 'remove').filter(row => row.repository === deleted).length, 1);
    assert.equal(writes(f, 'remove').length, 2);
    assert.deepEqual([...f.provider.repositories], [['unrelated/repository', foreign]]);
    assert.equal(f.provider.revoked, true);
  });

for (const change of ['permission', 'not-found', 'run-id', 'run', 'resource',
  'sources', 'execution', 'wake-resource']) {
  test(`dispatch recovery retains Pending with ${change} evidence`, async t => {
    const fixtureState = await fixture(t, lost('trigger', 2));
    await installed(fixtureState.current);
    await fixtureState.current.run(selected('delivery'));
    const f = await fixtureState.restart();
    const before = await snapshot(f);
    const phase = before.suite.phases.delivery;
    const record = f.provider.phases.get(phase.intent);
    const saved = copy(record);
    const observe = f.provider.observe;
    const leg = record.legs[0];
    if (change === 'permission' || change === 'not-found') {
      f.provider.observe = target => {
        if (target.kind === 'run') {
          if (change === 'permission') throw new Error('403 private diagnostic');
          return { complete: false, target, data: null };
        }
        return observe(target);
      };
    }
    if (change === 'run-id') delete leg.wake.expected.runId;
    if (change === 'execution') leg.wake.expected.runId += 10000;
    if (change === 'wake-resource') leg.wake.expected.issue += 1;
    if (change === 'run') record.runId = 'another-run';
    if (change === 'resource') leg.binding.repository = 'another/repository';
    if (change === 'sources') record.sources = { other: {} };
    const pending = await f.run(selected('delivery'));
    assert.equal(pending.outcome, 'non-passing');
    assert.equal(pending.phases.delivery.state, 'unresolved');
    assert(pending.phases.delivery.resources.length > 0);
    assert(!JSON.stringify(pending).includes('private diagnostic'));
    unchanged(before, await snapshot(f), 'delivery');
    assert.equal((await f.run(selected('cleanup'))).cleanup, 'pending');
    assert.equal(writes(f, 'remove').length, 0);
    assert.equal(writes(f, 'trigger').length, 2);
    assert.equal(f.provider.repositories.size, 2);
    f.provider.observe = observe;
    f.provider.phases.set(phase.intent, saved);
    const recovered = await f.run(selected('delivery'));
    assert.equal(recovered.phases.delivery.state, 'passed', JSON.stringify(recovered));
    unchanged(before, await snapshot(f), 'delivery');
    assert.equal(writes(f, 'trigger').length, 2);
  });
}

for (const change of ['missing', 'operation', 'resource', 'run', 'sources']) {
  test(`create recovery refuses ${change} receipt and later settles same intent`,
    async t => {
      const fixtureState = await fixture(t, lost('create'));
      await fixtureState.current.run(selected('provision', false));
      const f = await fixtureState.restart();
      const before = await snapshot(f);
      const receipt = f.provider.receipt;
      const remote = f.provider.snapshot();
      const retained = remote.receipts.get(before.repositories[0].operation);
      if (change === 'run') retained.runId = 'other-run';
      if (change === 'sources') retained.sourceOwner = 'other-sources';
      if (change === 'resource') retained.repository = 'other/resource';
      if (change === 'missing') remote.receipts.clear();
      if (change === 'operation') retained.operation = 'other-intent';
      const observer = simulatedProvider(f.provider.definition, remote);
      observer.scope(runId, 'provision');
      f.provider.receipt = record => observer.receipt(record);
      const pending = await f.run(selected('provision'));
      assert.equal(pending.phases.provision.state, 'unresolved');
      assert.equal(pending.outcome, 'non-passing');
      unchanged(before, await snapshot(f), 'provision');
      assert.equal(writes(f, 'create').length, 1);
      assert.equal((await f.run(selected('cleanup'))).cleanup, 'pending');
      assert.equal(writes(f, 'remove').length, 0);
      f.provider.receipt = receipt;
      assert.equal((await f.run(selected('provision'))).phases.provision.state,
        'passed');
      unchanged(before, await snapshot(f), 'provision');
      assert.equal(writes(f, 'create').filter(row =>
        row.repository === before.repositories[0].repository).length, 1);
    });
}

for (const change of ['not-found', 'permission', 'resource', 'identity']) {
  test(`delete recovery retains deletion intent with ${change} observation`, async t => {
    const fixtureState = await fixture(t, lost('remove'));
    await fixtureState.current.run(selected('provision', false));
    await fixtureState.current.run(selected('cleanup'));
    const f = await fixtureState.restart();
    const before = await snapshot(f);
    const deleted = before.repositories[0].repository;
    const operation = before.teardown.operations.find(row => row.operation === 'delete');
    assert.equal(operation.disposition, 'unresolved');
    const observe = f.provider.repositoryEvidence;
    f.provider.repositoryEvidence = record => {
      const value = observe.call(f.provider, record);
      if (record.repository !== deleted) return value;
      if (change === 'not-found') return { ...value, complete: false, absent: true };
      if (change === 'permission') return { ...value, access: 'denied' };
      if (change === 'resource') return { ...value, repository: 'other/resource' };
      return { ...value, id: value.id + 1 };
    };
    const pending = await f.run(selected('cleanup'));
    assert.equal(pending.cleanup, 'pending');
    assert.equal(pending.phases.cleanup.code, 'CLEANUP_UNRESOLVED_repositories');
    assert(pending.phases.cleanup.resources.includes(deleted));
    assert.equal(writes(f, 'remove').length, 1);
    const unresolved = await snapshot(f);
    assert.deepEqual(unresolved.teardown.operations.find(row =>
      row.operation === 'delete'), operation);
    unchanged(before, unresolved, 'cleanup');
    assert.equal(f.provider.repositories.size, 1);
    assert.equal(f.provider.revoked, false);
    f.provider.repositoryEvidence = observe;
    assert.equal((await f.run(selected('cleanup'))).cleanup, 'complete');
    unchanged(before, await snapshot(f), 'cleanup');
    assert.equal(writes(f, 'remove').filter(row => row.repository === deleted).length, 1);
    assert.equal(writes(f, 'remove').length, 2);
  });
}

test('restart rechecks completed delivery and failure using fresh clients', async t => {
  const fixtureState = await fixture(t);
  let f = fixtureState.current;
  await installed(f);
  await f.run(selected('delivery'));
  const failed = await f.run(selected('failure'));
  assert.equal(failed.phases.failure.state, 'passed');
  const before = await snapshot(f);
  f = await fixtureState.restart();
  const result = await f.run(selected('failure'));
  assert.equal(result.phases.failure.state, 'passed', JSON.stringify(result));
  unchanged(before, await snapshot(f), 'failure');
  assert.equal(writes(f, 'trigger').length, 4);
});

test('ordinary suite requests cannot enable lost-reply controls', async t => {
  const fixtureState = await fixture(t);
  const f = fixtureState.current;
  const result = await f.run({ runId, controls: lost('create') });
  assert.equal(result.outcome, 'passed');
  assert(!f.trace().some(row => row.outcome === 'reply-lost'));
});

test('restart retains run and source ownership refusals before further effects',
  async t => {
    const fixtureState = await fixture(t, lost('trigger', 2));
    await installed(fixtureState.current);
    await fixtureState.current.run(selected('delivery'));
    const f = await fixtureState.restart();
    const before = await snapshot(f);
    await assert.rejects(f.run({ runId: 'replacement', phase: 'delivery', resume: true }),
      /SUITE_BINDING_CONFLICT/);
    const source = f.prepared.sources.core;
    const commit = source.commit;
    source.commit = 'f'.repeat(40);
    await assert.rejects(f.run(selected('delivery')), /SUITE_BINDING_CONFLICT/);
    source.commit = commit;
    assert.equal(writes(f, 'trigger').length, 2);
    assert.equal(writes(f, 'remove').length, 0);
    unchanged(before, await snapshot(f), 'delivery');
    assert.equal((await f.run(selected('delivery'))).phases.delivery.state, 'passed');
  });

test('a complete run recovers a committed create and safely cleans up in place',
  async t => {
    const fixtureState = await fixture(t, lost('create'));
    const pending = await fixtureState.current.run({ runId });
    assert.equal(pending.phases.provision.state, 'unresolved');
    assert.equal(pending.cleanup, 'pending');
    const before = await snapshot(fixtureState.current);
    const f = await fixtureState.restart();
    const result = await f.run({ runId, resume: true });
    assert.equal(result.outcome, 'passed', JSON.stringify(result));
    unchanged(before, await snapshot(f), 'provision');
    assert.equal(writes(f, 'create').length, 2);
    assert.equal(writes(f, 'remove').length, 2);
  });

test('complete dispatch recovery continues the original suite and then cleans up',
  async t => {
    const fixtureState = await fixture(t, lost('trigger', 2));
    const pending = await fixtureState.current.run({ runId });
    assert.equal(pending.phases.delivery.state, 'unresolved');
    assert.equal(pending.cleanup, 'pending');
    const before = await snapshot(fixtureState.current);
    const identities = [...fixtureState.current.provider.executions.keys()];
    const f = await fixtureState.restart();
    const result = await f.run({ runId, resume: true });
    assert.equal(result.outcome, 'passed', JSON.stringify(result));
    unchanged(before, await snapshot(f), 'delivery');
    assert.deepEqual([...f.provider.executions.keys()].slice(0, 2), identities);
    assert.equal(writes(f, 'trigger').filter(row => row.phase === 'delivery').length, 2);
    assert.equal(writes(f, 'trigger').length, 4);
    assert.equal(writes(f, 'remove').length, 2);
  });
