import test from 'node:test';
import assert from 'node:assert/strict';
import { observePressure, pressureCases } from '../pressure-observations.mjs';
import { pressureFixture } from '../scenarios/pressure-fixtures.mjs';
import { controlledPressureRows, verify } from '../scenarios/pressure.mjs';
import { runPressureSmoke } from '../pressure-smoke.mjs';

for (const phase of pressureCases) {
  test(`${phase}: controlled pressure observations and missing evidence`, () => {
    const { binding, evidence } = pressureFixture(phase);
    const expected = phase === 'pending' ? 'unverified' : 'passed';
    assert.equal(observePressure(binding, evidence).state, expected);
    for (const key of ['samples', 'diagnostics', 'coverage', 'complete']) {
      const missing = structuredClone(evidence);
      delete missing[key];
      assert.equal(observePressure(binding, missing).state, 'unverified');
    }
  });
}
function check(phase, edit, code) {
  const { binding, evidence } = pressureFixture(phase);
  edit(evidence);
  const result = observePressure(binding, evidence);
  assert.notEqual(result.state, 'passed');
  if (code) assert.equal(result.code, code);
}
test('identity, bounded waiting, and serial indication alone cannot pass', () => {
  check('healthy', e => { e.samples[0].experimentId = 'foreign'; });
  check('healthy', e => { e.diagnostics[0].executionId = 'replacement'; });
  check('healthy', e => { e.diagnostics[0].at = 9; });
  check('healthy', e => { e.diagnostics[1].elapsedMs = 3; });
  check('healthy', e => { e.independentEligible = false; });
  check('healthy', e => { e.samples[0].clockId = 'other-clock'; });
  check('healthy', e => { e.samples.push({ ...e.samples[0], mode: 'wait' }); });
  check('healthy', e => { e.diagnostics.push({ ...e.diagnostics[0], at: 3 }); });
  check('healthy', e => { e.samples.push({ ...e.samples[0], at: 0 });
    e.samples[0].mode = 'wait'; });
  check('healthy', e => { e.writers[1].start = 4; });
  check('serial', e => { e.writers[1].start = 3; e.samples[1].at = 3; },
    'SERIAL_WRITERS_OVERLAP');
  check('serial', e => { e.writers = []; });
  check('expired', e => { e.waitBoundMs = 300001; });
  check('expired', e => { e.samples = e.samples.slice(0, 1); });
  check('expired', e => { e.diagnostics[0].code = 'WSL_CONNECTION_TIMEOUT'; });
  check('expired', e => { e.diagnostics[0].elapsedMs = 9; });
});
test('Job conclusions and timeout diagnostics cannot resolve recovery', () => {
  for (const conclusion of ['cancelled', 'success']) {
    check('recovered', e => { e.writers[0].end = null;
      e.jobConclusion = conclusion; }, 'PENDING_TERMINATION_OR_EFFECTS');
  }
  for (const key of ['termination', 'effects', 'authorization']) {
    check('recovered', e => { e.recovery[key] = 'unknown'; });
  }
  check('recovered', e => { e.recovery.confirmedAt = 7; }, 'UNSAFE_REPLACEMENT');
  check('healthy', e => { e.effects = 'unknown'; });
  assert.equal(verify({ rows: controlledPressureRows(), coreCompleted: true }), true);
  assert.equal(controlledPressureRows().every(r => !r.liveVerified), true);
});
const limits = { timeoutMs: 1000, requestTimeoutMs: 100, requests: 8,
  operations: 2 };
function hostFixture() {
  const { binding, evidence } = pressureFixture();
  const calls = { experiment: 0, cleanup: 0 };
  const host = { adoptedTestHost: true, production: false,
    inventory: async () => ({ complete: true, activeGuests: ['existing'] }),
    experiment: async (b, constraints) => {
      calls.experiment++;
      assert.equal(constraints.restartWSL, false);
      assert.deepEqual(constraints.preserveGuests, ['existing']);
      return { experimentId: b.experimentId, effects: 'reconciled',
        resources: [{ id: 'owned', owner: b.experimentId, disposable: true,
          retired: true }] };
    },
    observe: async () => evidence,
    cleanup: async () => { calls.cleanup++;
      return { complete: true, effects: 'reconciled' }; },
  };
  return { binding, evidence, host, calls };
}
test('smoke requires explicit adoption and finite limits', async () => {
  const f = hostFixture();
  assert.equal((await runPressureSmoke(f.binding, f.host)).code,
    'FINITE_BOUNDS_REQUIRED');
  assert.equal((await runPressureSmoke({}, f.host, limits)).code,
    'PRESSURE_BINDING_REQUIRED');
  assert.equal(f.calls.experiment, 0);
  assert.equal((await runPressureSmoke(f.binding, {}, limits)).code,
    'CAPABILITY_UNAVAILABLE');
  const result = await runPressureSmoke(f.binding, f.host, limits);
  assert.equal(result.state, 'passed');
  assert.equal(result.liveVerified, false);
  assert.equal(f.calls.cleanup, 1);
});
test('unknown effects and active or foreign resources are retained', async () => {
  for (const edit of [
    f => { f.host.experiment = async () => { f.calls.experiment++;
      throw new Error('private'); }; },
    f => { f.host.experiment = async () => new Promise(() => {}); },
    f => { f.evidence.writers[0].end = null; },
    f => { f.evidence.effects = 'unknown'; },
    f => { f.host.experiment = async () => ({ experimentId: f.binding.experimentId,
      effects: 'reconciled', resources: [{ id: 'existing',
        owner: f.binding.experimentId, retired: true, disposable: true }] }); },
  ]) {
    const f = hostFixture();
    edit(f);
    const result = await runPressureSmoke(f.binding, f.host,
      { ...limits, requestTimeoutMs: 10 });
    assert.equal(result.state, 'unverified');
    assert.equal(result.cleanup, 'unresolved');
    assert.equal(result.recoveryState.experimentId, f.binding.experimentId);
    assert.equal(f.calls.cleanup, 0);
    assert.ok(f.calls.experiment <= 1);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});
test('cleanup and preservation failures cannot pass and are never retried', async () => {
  const f = hostFixture();
  f.host.cleanup = async () => { f.calls.cleanup++;
    throw new Error('uncertain'); };
  assert.equal((await runPressureSmoke(f.binding, f.host, limits)).code,
    'CLEANUP_EFFECT_UNKNOWN');
  assert.equal(f.calls.cleanup, 1);
  const g = hostFixture();
  let reads = 0;
  g.host.inventory = async () => ({ complete: true,
    activeGuests: ++reads === 1 ? ['existing'] : [] });
  assert.equal((await runPressureSmoke(g.binding, g.host, limits)).code,
    'HOST_PRESERVATION_UNVERIFIED');
  assert.equal(g.calls.cleanup, 0);
});

test('cleanup requires retired owned resources and preserves guests', async () => {
  for (const resource of [
    { id: 'owned', owner: 'foreign', disposable: true, retired: true },
    { id: 'owned', owner: 'controlled-1', disposable: false, retired: true },
    { id: 'owned', owner: 'controlled-1', disposable: true, retired: false },
  ]) {
    const f = hostFixture();
    f.host.experiment = async () => ({ experimentId: f.binding.experimentId,
      effects: 'reconciled', resources: [resource] });
    const result = await runPressureSmoke(f.binding, f.host, limits);
    assert.equal(result.code, 'CLEANUP_OWNERSHIP_UNVERIFIED');
    assert.equal(f.calls.cleanup, 0);
    assert.deepEqual(result.recoveryState.resources, [resource]);
  }
  const f = hostFixture();
  let reads = 0;
  f.host.inventory = async () => ({ complete: true,
    activeGuests: ++reads < 3 ? ['existing'] : [] });
  assert.equal((await runPressureSmoke(f.binding, f.host, limits)).code,
    'HOST_PRESERVATION_UNVERIFIED');
  assert.equal(f.calls.cleanup, 1);
});
