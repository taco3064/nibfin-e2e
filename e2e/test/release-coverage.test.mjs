import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCoverageFixture } from './release-coverage-support.mjs';
import { createReleaseGate } from '../release-gate.mjs';
import { runReleaseCoverage } from '../release-coverage.mjs';
import { scenarios } from '../registry.mjs';
import { catalog } from '../coverage-catalog.mjs';

async function blocked(f) {
  const actual = await f.invoke();
  assert.equal(actual.outcome, 'blocked', JSON.stringify(actual));
  assert.equal(actual.handoff, undefined);
  assert.equal(f.state.staged, 0);
  assert.equal(f.state.writes, 0);
  return actual;
}

test('complete native composition uses one source owner, controlled evidence only',
  async t => {
    const f = await releaseCoverageFixture(t);
    const actual = await f.invoke();
    assert.equal(actual.outcome, 'ready', actual.reason);
    assert.equal(actual.handoff.mode, 'contract-test');
    assert.deepEqual(actual.handoff.mandatory.scenarioIds,
      ['action.invocation', 'cli.invocation', 'delivery.paired.live']);
    assert.deepEqual(f.state,
      { prepared: 1, disposed: 1, staged: 1, writes: 0 });
    for (const leg of f.pair.legs) {
      assert.equal(leg.binding.sources, f.prepared.sources);
      assert.equal(leg.binding.sourceRoot, f.prepared.root);
    }
    assert.equal(f.cli.commands.length, 1);
    assert.equal(f.cli.commands[0].settings.intent.invocation.runId, '123');
  });

for (const change of [
  r => { delete r.release; },
  r => { r.release.invocation.repository = 'other/repository'; },
  r => { r.release.invocation.runId = 'old'; },
  r => { r.release.invocation.attempt = '2'; },
  r => { r.release.invocation.environment = 'ordinary'; },
  r => { r.release.sources[0].commit = 'f'.repeat(40); },
  r => { r.release.sources[1].repository = 'other/action'; },
  r => { r.release.challenge = 'previous-attempt'; },
]) {
  test('rejects absent, stale or mismatched authenticated release binding', async t => {
    const f = await releaseCoverageFixture(t);
    f.editEnvelope = change;
    await blocked(f);
  });
}

for (const change of [
  a => { delete a.delivery.caller.readDeliveryEvidence; },
  a => { delete a.action.readEvidence; },
  a => { delete a.cli.context.command; },
  a => { a.delivery.caller.mode = 'live'; },
  a => { a.cli.context.origin = 'operator'; },
]) {
  test('missing capabilities or provenance blocks before producer execution', async t => {
    const f = await releaseCoverageFixture(t);
    f.editAdapters = change;
    await blocked(f);
    assert.equal(f.pair.legs.length, 0);
    assert.equal(f.state.disposed, 1);
  });
}

for (const change of [
  f => { f.action.evidence.action.executed = false; },
  f => { f.action.evidence.action.outputs.code = 'wrong'; },
  f => { f.action.evidence.core = []; },
  f => { f.action.evidence.run.data.run_attempt++; },
  f => { f.action.evidence.run.data.repository.full_name = 'other/repo'; },
  f => { f.action.evidence.jobs.data[0].steps[0].conclusion = 'skipped'; },
  f => { f.action.expected.status = 'pending'; },
  f => { f.action.expected.actionRef = 'taco3064/nibfin-act@stale'; },
  f => { f.action.evidence = { state: 'passed' }; },
]) {
  test('Action requires executed native step and matching Core outputs', async t => {
    const f = await releaseCoverageFixture(t);
    change(f);
    await blocked(f);
    assert.equal(f.cli.commands.length, 0);
    assert.equal(f.state.disposed, 1);
  });
}

for (const channel of ['github', 'host']) {
  for (const field of ['id', 'runId', 'attempt', 'entry', 'fresh', 'origin']) {
    test(`CLI rejects stale or absent ${channel} ${field} in gate`, async t => {
      const f = await releaseCoverageFixture(t);
      const observe = f.cli.context.observe;
      f.cli.context.observe = async (...args) => {
        const raw = await observe(...args);
        if (raw.invocation) raw.invocation[channel][field] = null;
        return raw;
      };
      await blocked(f);
      assert.equal(f.state.disposed, 1);
    });
  }
}

test('CLI pending effects retain sources and durable recovery inventory', async t => {
  const f = await releaseCoverageFixture(t);
  f.cli.context.command = async () => ({ terminated: false });
  await blocked(f);
  assert.equal(f.state.disposed, 0);
  assert((await f.cli.read()).installation.pending.invocation.id);
});

test('paired delivery unknown effects retain the one gate-owned source set', async t => {
  const f = await releaseCoverageFixture(t);
  f.pair.caller.trigger = async () => { throw new Error('unknown dispatch'); };
  await blocked(f);
  assert.equal(f.state.disposed, 0);
  assert.equal(f.pair.events.some(e => e.startsWith('cleanup')), false);
});

test('changed checkout paths and pins cannot reach release preparation', async t => {
  const f = await releaseCoverageFixture(t);
  const command = f.cli.context.command;
  f.cli.context.command = async (...args) => {
    const result = await command(...args);
    f.prepared.sources.action.checkout = '/substituted';
    return result;
  };
  await blocked(f);
  assert.equal(f.state.disposed, 1);
});

test('production refuses absent protected capabilities before acquisition', async t => {
  const f = await releaseCoverageFixture(t);
  delete f.capabilities.coverage;
  const actual = await createReleaseGate(f.capabilities)(['1.2.3']);
  assert.equal(actual.outcome, 'blocked');
  assert.match(actual.reason, /protected capabilities unavailable/);
});

test('production cannot upgrade a complete controlled producer set', async t => {
  const f = await releaseCoverageFixture(t);
  const selected = scenarios.filter(row => catalog.some(c =>
    c.scenarioIds.includes(row.id)));
  await assert.rejects(runReleaseCoverage(f.capabilities.coverage, f.prepared,
    f.identity, selected, 'production'), /provenance/);
  assert.equal(f.pair.legs.length, 0);
});

for (const change of [
  e => { e.stages.pop(); },
  e => { e.stages[0].repository = 'other/repository'; },
  e => { e.stages[0].outcome = 'pending'; },
  e => { e.stages[0].outcome = 'skipped'; },
  e => { e.candidate = null; },
]) {
  test('Core gate requires native paired independent delivery assertions', async t => {
    const f = await releaseCoverageFixture(t);
    const read = f.pair.caller.readDeliveryEvidence;
    f.pair.caller.readDeliveryEvidence = async (...args) => {
      const evidence = await read(...args);
      change(evidence);
      return evidence;
    };
    await blocked(f);
    assert.equal(f.cli.commands.length, 0);
  });
}

test('production provenance labels cannot upgrade synthetic native observations',
  async t => {
    const f = await releaseCoverageFixture(t);
    f.editAdapters = a => {
      a.delivery.caller.mode = 'live';
      a.cli.context.origin = 'operator';
    };
    const selected = scenarios.filter(row => catalog.some(c =>
      c.scenarioIds.includes(row.id)));
    await assert.rejects(runReleaseCoverage(f.capabilities.coverage, f.prepared,
      f.identity, selected, 'production'), /producer effects unresolved/);
  });

test('ordinary Action worker cannot consume injected capabilities', async () => {
  const worker = await import('../scenarios/action-invocation.mjs');
  assert(worker.prerequisite({ readEvidence: () => ({ state: 'passed' }) }));
  assert.throws(() => worker.run({ state: 'passed' }));
  assert.equal(worker.verify({ state: 'passed' }), false);
});

for (const phase of ['assertSource', 'readIsolationEvidence']) {
  test(`unknown ${phase} termination survives producer error reduction`, async t => {
    const f = await releaseCoverageFixture(t);
    f.pair.caller[phase] = async () => {
      throw Object.assign(new Error('unsettled native process'),
        { terminationUnknown: true });
    };
    await blocked(f);
    assert.equal(f.state.disposed, 0);
    assert.equal(f.pair.events.some(e => e.startsWith('cleanup')), false);
  });
}

test('producer timeout retains sources until the underlying call has settled',
  async t => {
    const f = await releaseCoverageFixture(t);
    let settle;
    f.pair.caller.assertSource = () => new Promise(resolve => { settle = resolve; });
    f.editAdapters = a => {
      a.delivery.bounds = { requestTimeoutMs: 100, timeoutMs: 2000 };
    };
    try {
      const actual = await blocked(f);
      assert.match(actual.reason, /producer unsettled/);
      assert.equal(f.state.disposed, 0);
    } finally { settle?.({ state: 'unverified' }); }
  });
