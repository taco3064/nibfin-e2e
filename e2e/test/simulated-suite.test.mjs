import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createSimulatedSuite } from '../simulated-suite.mjs';
import { requireNativeSuite, suitePhases } from '../suite-result.mjs';
import { simulatedSourceAssertion } from '../simulated-local.mjs';

async function fixture(t) {
  const f = await createSimulatedSuite();
  let started = false;
  let cleaned = false;
  const run = f.run;
  f.run = async request => {
    started = true;
    const result = await run(request);
    cleaned = result.cleanup === 'complete';
    return result;
  };
  t.after(async () => {
    if (started && !cleaned) await run({ runId: 'simulation',
      phase: 'cleanup', resume: true });
    await f.dispose();
    await assert.rejects(access(f.root), { code: 'ENOENT' });
  });
  return f;
}
const request = { runId: 'simulation' };
const selected = (phase, resume = true) => ({ ...request, phase, resume });

async function installed(f) {
  await f.run(selected('provision', false));
  const result = await f.run(selected('install'));
  assert.equal(result.phases.install.state, 'passed');
}

test('offline complete suite starts empty and retains controlled evidence', async t => {
  const f = await fixture(t);
  const initial = await f.inventory.exclusive(state => structuredClone(state));
  assert.equal(initial.repositories, undefined);
  assert.deepEqual(initial.resources, []);
  const unrelated = { owner: 'unrelated', native: { id: 999 } };
  f.provider.repositories.set('unrelated/repository', unrelated);
  const foreign = { id: 999, repositoryId: 999, memberId: 999 };
  f.provider.registrations.set(999, foreign);
  const target = { kind: 'registration', id: '999', owner: 'unrelated',
    hostId: 'other-host', active: true, absent: false };
  f.provider.targets.set('999', target);
  const result = await f.run(request);
  assert.equal(result.outcome, 'passed', JSON.stringify(result));
  for (const phase of suitePhases) assert.equal(result.phases[phase].state, 'passed');
  assert.equal(result.provenance, 'controlled');
  assert.equal(result.sourceOwner, f.prepared.ownershipId);
  assert.equal(f.prepared.disposed, false);
  assert.deepEqual([...f.provider.repositories], [['unrelated/repository', unrelated]]);
  assert.deepEqual([...f.provider.registrations], [[999, foreign]]);
  assert.deepEqual(f.provider.targets.get('999'), target);
  assert.equal(f.provider.localResources.size, 0);
  assert.equal(f.provider.revoked, true);
  assert.equal(f.provider.settled, true);
  const trace = f.trace();
  assert(trace.every(row => row.runId === request.runId));
  assert(trace.every(row => row.sourceOwner === f.prepared.ownershipId));
  assert(trace.every(row => row.owner === initial.definition.owner));
  assert.deepEqual([...new Set(trace.map(row => row.phase))], suitePhases);
  assert.equal(trace.filter(row => row.operation === 'execute-javascript' &&
    row.outcome === 'satisfied').length, 4);
  assert(trace.some(row => row.resource?.kind === 'jobs'));
  assert(trace.some(row => row.resource?.kind === 'pull'));
  const fault = [...f.provider.executions.values()][2].ledger.faultExecution;
  assert.equal(fault.state, 'completed');
  assert.equal(fault.sourceRoot, f.prepared.root);
  assert.equal(fault.evidence.effects, 'reconciled');
  assert.throws(() => requireNativeSuite(result, f.prepared, {
    repository: 'simulated', runId: 'local', attempt: '1',
  }), /SUITE: native/);
  await f.dispose();
  assert.deepEqual(f.trace(), trace);
});

test('each selected phase consumes and reconciles completed prerequisites', async t => {
  const f = await fixture(t);
  for (const [index, phase] of suitePhases.entries()) {
    const result = await f.run(selected(phase, index !== 0));
    assert.equal(result.phases[phase].state, 'passed', JSON.stringify(result));
    const later = suitePhases[index + 1];
    if (later) assert.equal(result.phases[later].state, 'unobserved');
    if (phase === 'install') {
      const rows = [...f.provider.registrations.values()];
      assert.equal(rows.length, 2);
      assert(rows.every(row => row.repositoryId === 11 && row.shared));
      for (const repository of f.provider.repositories.values()) {
        assert.equal(repository.native.visibility, 'public');
        assert.equal(repository.native.private, false);
      }
    }
  }
  const triggers = f.trace().filter(row => row.operation === 'trigger' &&
    row.outcome === 'observed');
  assert.equal(triggers.length, 4);
});

for (const phase of ['install', 'delivery', 'failure']) {
  test(`missing prerequisites for selected ${phase} never execute ancestors`, async t => {
    const f = await fixture(t);
    const result = await f.run(selected(phase, false));
    assert.equal(result.phases[phase].state, 'missing-input');
    const expected = { install: 'PROVISION', delivery: 'INSTALL', failure: 'DELIVERY' };
    assert.equal(result.phases[phase].code, `MISSING_${expected[phase]}`);
    assert.equal(f.trace().length, 0);
    assert.equal(f.provider.repositories.size, 0);
  });
}

test('private readback is rejected before any simulated installation effect', async t => {
  const f = await fixture(t);
  await f.run(selected('provision', false));
  const row = [...f.provider.repositories.values()][0];
  row.native.visibility = 'private';
  row.native.private = true;
  const result = await f.run(selected('install'));
  assert.equal(result.phases.install.state, 'unresolved');
  assert.equal(f.provider.registrations.size, 0);
  assert.equal(row.installed, false);
  assert(f.trace().some(row => row.outcome === 'SIM_PUBLIC_REPOSITORY_REQUIRED'));
});

test('resource and network refusals have sanitized diagnostics', async t => {
  const f = await fixture(t);
  await installed(f);
  const repository = f.provider.definition.repositories[0];
  assert.throws(() => f.provider.authorize('trigger', repository, 999),
    /SIM_OPERATION_DENIED/);
  assert.throws(() => f.provider.observe({ kind: 'issue',
    repository: 'unrelated/secret', number: 99 }), /SIM_RESOURCE_UNRELATED/);
  assert.throws(() => f.provider.observe({ kind: 'issue', repository, number: 99 }),
    /SIM_RESOURCE_UNKNOWN/);
  assert.throws(() => f.provider.network('https://secret.invalid'),
    /SIM_NETWORK_FORBIDDEN/);
  const trace = JSON.stringify(f.trace());
  assert(!trace.includes('secret'));
  assert(!trace.includes('https://'));
});

for (const change of ['head', 'checks', 'content', 'merge']) {
  test(`contradicted ${change} readback cannot reconcile as passing`, async t => {
    const f = await fixture(t);
    await installed(f);
    const delivered = await f.run(selected('delivery'));
    assert.equal(delivered.phases.delivery.state, 'passed');
    const leg = [...f.provider.executions.values()][0];
    const repository = leg.binding.repository;
    if (change === 'content') leg.merged.content = 'process.stdout.write("wrong");\n';
    if (change === 'merge') leg.merged.commit = '0'.repeat(40);
    if (change === 'head') {
      const target = { kind: 'pull', repository, number: leg.evidence.pull.number };
      const pull = f.provider.observe(target).data;
      f.provider.store(target, { ...pull, head: { sha: '0'.repeat(40) } });
    }
    if (change === 'checks') {
      const target = { kind: 'checks', repository, sha: leg.evidence.pull.head };
      const checks = f.provider.observe(target).data;
      checks[0].conclusion = 'failure';
      f.provider.store(target, checks);
    }
    const result = await f.run(selected('delivery'));
    assert.equal(result.phases.delivery.state, 'unresolved', JSON.stringify(result));
    assert.equal(f.trace().filter(row => row.operation === 'trigger' &&
    row.outcome === 'observed').length, 2);
  });
}

test('maintained merged assertion executes Node and rejects incorrect exact stdout',
  async t => {
    const f = await fixture(t);
    await installed(f);
    await f.run(selected('delivery'));
    const leg = [...f.provider.executions.values()][0];
    const binding = { ...leg.binding, mergeCommit: leg.merged.commit,
      stdout: 'incorrect expected output\n' };
    const result = await simulatedSourceAssertion(f.provider, leg, binding,
      AbortSignal.timeout(5000));
    assert.equal(result.state, 'contradicted');
    assert.equal(result.stdout, leg.binding.stdout);
    assert.equal(result.exitCode, 0);
  });

test('failure reconciliation retains evidence without redispatch', async t => {
  const f = await fixture(t);
  for (const [index, phase] of suitePhases.slice(0, -1).entries()) {
    const result = await f.run(selected(phase, index !== 0));
    assert.equal(result.phases[phase].state, 'passed');
  }
  const result = await f.run(selected('failure'));
  assert.equal(result.phases.failure.state, 'passed', JSON.stringify(result));
  const triggers = f.trace().filter(row => row.operation === 'trigger' &&
    row.outcome === 'observed');
  assert.equal(triggers.length, 4);
});

for (const change of ['review', 'association', 'unavailable']) {
  test(`initial ${change} contradiction cannot be promoted to suite success`, async t => {
    const f = await fixture(t);
    await installed(f);
    const store = f.provider.store;
    f.provider.store = (target, data) => {
      store(target, data);
      if (target.kind !== 'pull') return;
      const leg = [...f.provider.executions.values()].find(leg =>
        leg.evidence.pull.number === target.number);
      if (change === 'review') {
        leg.evidence.stages.find(stage => stage.stage === 'review-pr')
          .outcome = 'failure';
      }
      if (change === 'association') leg.evidence.stages[3].shape = 'other-shape';
    };
    const observe = f.provider.observe;
    f.provider.observe = target => {
      const result = observe(target);
      if (change === 'unavailable' && target.kind === 'pull') result.complete = false;
      return result;
    };
    const result = await f.run({ ...request, resume: true });
    assert.equal(result.outcome, 'non-passing');
    assert.equal(result.phases.delivery.state, 'unresolved');
    assert.equal(result.phases.failure.state, 'unobserved');
    assert.equal(result.cleanup, 'complete');
  });
}

test('installation preserves colliding unrelated host resources and refuses effects',
  async t => {
    const f = await fixture(t);
    await f.run(selected('provision', false));
    const foreign = { id: 400, repositoryId: 999, memberId: 999 };
    f.provider.registrations.set(400, foreign);
    const result = await f.run(selected('install'));
    assert.equal(result.phases.install.state, 'unresolved');
    assert.deepEqual([...f.provider.registrations], [[400, foreign]]);
    assert.equal(f.provider.targets.size, 0);
  });

test('unobserved fault effects cannot establish maintained recovery success', async t => {
  const f = await fixture(t);
  await installed(f);
  await f.run(selected('delivery'));
  const store = f.provider.store;
  f.provider.store = (target, data) => {
    if (target.kind === 'checks') data = data.map(check =>
      ({ ...check, conclusion: 'success' }));
    store(target, data);
  };
  const result = await f.run(selected('failure'));
  assert.equal(result.phases.failure.state, 'unresolved');
  assert.equal(result.phases.failure.code, 'EXACT_HEAD_FAILURE_UNVERIFIED');
});
