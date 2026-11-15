import test from 'node:test';
import assert from 'node:assert/strict';
import { installationFixture } from './installation-fixture.mjs';
import { protectedCliInvocation } from '../cli-invocation.mjs';
import * as worker from '../scenarios/cli-invocation.mjs';

async function fixture(t) {
  const f = await installationFixture(t);
  const command = f.context.command;
  let executed = null;
  f.context.command = async (...args) => {
    executed = structuredClone(args[2].intent.invocation);
    return command(...args);
  };
  f.context.observe = async () => ({ ...structuredClone(f.observation),
    invocation: executed ? Object.fromEntries(['github', 'host'].map(channel =>
      [channel, { ...executed, origin: 'synthetic', fresh: true, terminated: true,
        effects: 'reconciled' }])) : null });
  f.producer = () => protectedCliInvocation({ sources: f.sources,
    inventory: f.inventory, context: f.context,
    run: { runId: 'disposable-109', attempt: 1 } });
  return f;
}

test('installed state still invokes a new attempt, controlled proof stays controlled',
  async t => {
    const f = await fixture(t);
    const first = await f.producer().run();
    const second = await f.producer().run();
    assert.equal(first.disposition, 'success');
    assert.equal(second.disposition, 'success');
    assert.equal(second.invocation.evidence, 'controlled');
    assert.equal(second.protectedExecution, 'unverified');
    assert.notEqual(first.invocation.id, second.invocation.id);
    assert.equal(f.commands.length, 2);
    assert(!JSON.stringify(second).includes('secret'));
  });

for (const channel of ['github', 'host']) {
  for (const field of ['id', 'runId', 'attempt', 'entry', 'fresh', 'terminated',
    'effects', 'origin']) {
    test(`reject ${channel} incomplete or stale ${field}`, async t => {
      const f = await fixture(t);
      const observe = f.context.observe;
      f.context.observe = async (...args) => {
        const raw = await observe(...args);
        if (raw.invocation) raw.invocation[channel][field] = null;
        return raw;
      };
      const result = await f.producer().run();
      assert.equal(result.disposition, 'incomplete');
      assert.equal(result.invocation.confirmed, false);
      assert.equal(result.invocation.evidence, 'unverified');
    });
  }
}

for (const condition of ['repository', 'actor', 'source', 'pr', 'service',
  'registration', 'drift', 'synthetic-only']) {
  test(`reject ${condition} readback`, async t => {
    const f = await fixture(t);
    const observe = f.context.observe;
    f.context.observe = async (...args) => {
      const raw = await observe(...args);
      if (condition === 'repository') raw.binding.repositoryId++;
      if (condition === 'actor') raw.binding.memberId++;
      if (condition === 'source') raw.sources.cli.commit = 'f'.repeat(40);
      if (condition === 'pr') raw.installation.pullRequest = null;
      if (condition === 'service') raw.host.serviceState = null;
      if (condition === 'registration') raw.registrationsComplete = false;
      if (condition === 'drift' && raw.invocation) raw.runners[0].id++;
      if (condition === 'synthetic-only') delete raw.invocation;
      return raw;
    };
    const result = await f.producer().run();
    assert.notEqual(result.disposition, 'success');
    assert.equal(result.invocation.confirmed, false);
  });
}

test('unknown termination preserves bound intent until reconciliation', async t => {
  const f = await fixture(t);
  let invoked = false;
  f.context.command = async () => {
    invoked = true;
    return new Promise(() => {});
  };
  const first = await f.producer().run();
  assert.equal(invoked, true);
  assert.equal(first.invocation.invoked, true);
  assert.equal(first.invocation.terminated, false);
  assert(first.inventory.pending.invocation.id);
  f.context.reconcile = async () => ({ terminated: false, effects: 'unknown' });
  f.context.command = async () => assert.fail('unsafe repeat');
  const second = await f.producer().run();
  assert.deepEqual(second.inventory.pending, first.inventory.pending);
  assert.equal(second.disposition, 'incomplete');
});

test('missing capabilities and worker injection fail closed', async () => {
  assert.equal((await protectedCliInvocation().run()).disposition, 'prerequisite');
  assert.equal((await protectedCliInvocation({ context: {} }).run()).disposition,
    'prerequisite');
  assert(worker.prerequisite({ protectedCliInvocation }));
  assert.throws(() => worker.run({ protectedCliInvocation }));
  assert.equal(worker.verify({ disposition: 'success' }), false);
});

test('operator label cannot upgrade synthetic channel observations', async t => {
  const f = await fixture(t);
  f.context.origin = 'operator';
  const result = await f.producer().run();
  assert.equal(result.invocation.evidence, 'unverified');
  assert.equal(result.disposition, 'incomplete');
});

test('trusted native channels confirm invocation only', async t => {
  const f = await fixture(t);
  f.context.origin = 'operator';
  const observe = f.context.observe;
  f.context.observe = async (...args) => {
    const raw = await observe(...args);
    if (raw.invocation) {
      for (const channel of Object.values(raw.invocation)) channel.origin = 'native';
    }
    return raw;
  };
  const result = await f.producer().run();
  assert.equal(result.invocation.evidence, 'native');
  assert.equal(result.protectedExecution, 'unverified');
});

test('missing protected origin is an explicit prerequisite', async t => {
  const f = await fixture(t);
  delete f.context.origin;
  assert.equal((await f.producer().run()).disposition, 'prerequisite');
  assert.equal(f.commands.length, 0);
});
