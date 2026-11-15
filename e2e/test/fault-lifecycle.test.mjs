import test from 'node:test';
import assert from 'node:assert/strict';
import { runLifecycle } from '../lifecycle.mjs';
import { faultFixture } from './fault-support.mjs';

const request = { repository: 'fixture/repository',
  assignee: { id: 7, login: 'target-actor' } };

for (const fault of ['duplicate-continuation', 'failed-ci', 'cancelled-writer',
  'completed-attempt']) {
  test(`owned ${fault} restores, recovers and repeats without additional effects`,
    async () => {
      const f = faultFixture();
      const result = await runLifecycle({ ...request, case: fault }, f.caller);
      assert.equal(result.state, 'passed', JSON.stringify(result));
      assert.equal(result.liveVerified, false);
      assert.equal(result.mode, 'fixture');
      assert.equal(result.resumedJob.jobId, 301);
      assert.match(result.reason, new RegExp(fault));
      assert.deepEqual(f.operations, ['apply', 'read:before', 'restore', 'recover',
        'read:recover', 'repeat', 'read:repeat']);
      assert.equal(f.ledgers[0].faultExecution.state, 'completed');
      assert.ok(f.events.includes('cleanup:0'));
    });
}

for (const [fault, code] of [['unknown-termination', 'TERMINATION_UNKNOWN'],
  ['unknown-write', 'WRITE_EFFECT_UNKNOWN'], ['revoked-wake', 'WAKE_REVOKED']]) {
  test(`${fault} retains inventory without restoration or continuation`, async () => {
    const f = faultFixture();
    const result = await runLifecycle({ ...request, case: fault }, f.caller);
    assert.equal(result.code, code, JSON.stringify(result));
    assert.equal(result.state, 'unverified');
    assert.equal(result.cleanup, 'unresolved');
    assert.deepEqual(f.operations, ['apply', 'read:before']);
    assert.equal(f.ledgers[0].faultExecution.state, 'intent');
    assert.equal(f.events.some(e => e.startsWith('cleanup')), false);
  });
}

const defects = {
  'foreign operation': e => { e.operationId = 'foreign'; },
  'foreign execution': e => { e.execution = { ...e.execution, jobId: 999 }; },
  'incomplete history': e => { e.history.coverage.writers = false; },
  'queued': e => { e.status = 'queued'; },
  'capacity': e => { e.status = 'capacity'; },
  'no completed work proof': e => { e.completedWorkVerified = false; },
  'dependencies blocked': e => { e.dependenciesReady = false; },
  'overlap': e => {
    e.history.writers.push({ ...e.history.writers[0], executionId: 'second' });
  },
};
for (const [name, edit] of Object.entries(defects)) {
  test(`${name} cannot authorize recovery`, async () => {
    const f = faultFixture(edit);
    const result = await runLifecycle({ ...request, case: 'completed-attempt' },
      f.caller);
    assert.notEqual(result.state, 'passed');
    assert.equal(f.operations.includes('recover'), false);
    assert.equal(f.operations.includes('restore'), false);
  });
}

test('repeat with an additional committed effect fails and retains sources', async () => {
  const f = faultFixture((e, phase) => {
    if (phase === 'repeat') e.committedEffects.push('duplicate');
  });
  const result = await runLifecycle({ ...request, case: 'completed-attempt' }, f.caller);
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'DUPLICATE_COMMITTED_EFFECT');
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(f.events.some(e => e.startsWith('cleanup')), false);
});

test('missing protected capability blocks before creating fixtures', async () => {
  const f = faultFixture();
  delete f.caller.continueFault;
  const result = await runLifecycle({ ...request, case: 'cancelled-writer' }, f.caller);
  assert.equal(result.state, 'blocked');
  assert.equal(f.legs.length, 0);
});

for (const defect of ['stale', 'missing', 'skipped', 'unrelated', 'already-merged']) {
  test(`failed CI rejects ${defect} native evidence`, async () => {
    const f = faultFixture();
    const observe = f.caller.observe;
    f.caller.observe = async target => {
      const value = await observe(target);
      if (target.kind === 'checks') {
        if (defect === 'stale') value.data[0].head_sha = 'a'.repeat(40);
        if (defect === 'missing') value.data = [];
        if (defect === 'skipped') value.data[0].conclusion = 'skipped';
        if (defect === 'unrelated') value.data[0].id = 99;
      }
      if (target.kind === 'pull' && defect === 'already-merged') {
        value.data.merged = true;
      }
      return value;
    };
    const result = await runLifecycle({ ...request, case: 'failed-ci' }, f.caller);
    assert.equal(result.code, 'EXACT_HEAD_FAILURE_UNVERIFIED');
    assert.equal(f.operations.includes('recover'), false);
  });
}

test('Job cancellation without Writer termination proof refuses recovery', async () => {
  const f = faultFixture(e => { e.termination = 'unknown'; });
  const result = await runLifecycle({ ...request, case: 'cancelled-writer' }, f.caller);
  assert.equal(result.code, 'TERMINATION_UNKNOWN');
  assert.deepEqual(f.operations, ['apply', 'read:before']);
});

test('a native successful Job cannot demonstrate cancellation', async () => {
  const f = faultFixture();
  const observe = f.caller.observe;
  f.caller.observe = async target => {
    const value = await observe(target);
    if (target.kind === 'jobs') value.data[0].conclusion = 'success';
    return value;
  };
  const result = await runLifecycle({ ...request, case: 'cancelled-writer' }, f.caller);
  assert.notEqual(result.state, 'passed');
  assert.equal(f.operations.includes('recover'), false);
});

for (const defect of ['unknown-write', 'lost-history', 'missing-job', 'no-reuse']) {
  test(`recovery ${defect} prohibits repeated continuation`, async () => {
    const f = faultFixture((e, phase) => {
      if (phase !== 'recover') return;
      if (defect === 'unknown-write') e.effects = 'unknown';
      if (defect === 'lost-history') {
        e.history.writers.shift();
        e.history.admissions.shift();
      }
      if (defect === 'missing-job') delete e.resumedJob;
      if (defect === 'no-reuse') e.completedWorkVerified = false;
    });
    const result = await runLifecycle({ ...request, case: 'cancelled-writer' }, f.caller);
    assert.notEqual(result.state, 'passed');
    assert.equal(result.cleanup, 'unresolved');
    assert.equal(f.operations.includes('repeat'), false);
    assert.equal(f.events.some(e => e.startsWith('cleanup')), false);
  });
}

test('restoration failure preserves the owned intent and original fault', async () => {
  const f = faultFixture();
  f.caller.restoreFault = async () => { throw new Error('private provider details'); };
  const result = await runLifecycle({ ...request, case: 'failed-ci' }, f.caller);
  assert.equal(result.code, 'FAULT_RESTORATION_UNVERIFIED');
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(f.ledgers[0].faultExecution.state, 'restore-intent');
  assert.equal(f.ledgers[0].faultExecution.binding.case, 'failed-ci');
  assert.equal(f.operations.includes('recover'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('uncertain fault setup is invoked once and never restored blindly', async () => {
  const f = faultFixture();
  let attempts = 0;
  f.caller.applyFault = async () => { attempts++; throw new Error(); };
  const result = await runLifecycle({ ...request, case: 'unknown-write' }, f.caller);
  assert.equal(attempts, 1);
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(f.ledgers[0].faultExecution.state, 'intent');
  assert.deepEqual(f.operations, []);
});

test('inconsistent final Writer histories cannot establish exclusivity', async () => {
  const f = faultFixture((e, phase) => {
    if (phase !== 'before') e.history.writers[1].executionId = 'different-writer';
  });
  const result = await runLifecycle({ ...request, case: 'cancelled-writer' }, f.caller);
  assert.equal(result.state, 'unverified');
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(f.events.some(e => e.startsWith('cleanup')), false);
});
