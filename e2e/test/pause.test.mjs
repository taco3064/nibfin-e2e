import test from 'node:test';
import assert from 'node:assert/strict';
import { runPause } from '../pause-protected.mjs';
import { reconcilePauseExecution } from '../pause-recovery.mjs';
import { dependencyFixture } from './dependency-support.mjs';
import { select, scenarios } from '../registry.mjs';

async function fixture(t) {
  const f = await dependencyFixture(t);
  const events = [];
  const create = f.caller.createFixture;
  const observe = f.caller.observe;
  let evidence;
  let admissions = 0;
  f.caller.createFixture = async definition => {
    const owned = await create(definition);
    owned.api.mutateIssue = async record => {
      f.writes.push(record.mutation.kind);
      const adding = record.mutation.kind === 'add-issue-label';
      f.issues.get(29).labels = adding ? [{ name: 'pause' }] : [];
      events.push({ id: events.length + 1,
        url: `https://api.github.com/repos/${definition.repository}/issues/events/` +
          (events.length + 1),
        created_at: new Date(1700000000000 + events.length * 1000).toISOString(),
        event: adding ? 'labeled' : 'unlabeled', label: { name: 'pause' },
        actor: { id: 7, login: 'fixture', type: 'User' } });
    };
    return owned;
  };
  f.caller.observe = async target => target.kind === 'issue-events'
    ? { target, complete: true, data: structuredClone(events) } : observe(target);
  f.caller.admitPause = async binding => {
    admissions++;
    const paused = binding.phase === 'paused';
    const runId = 700 + admissions;
    const base = `https://api.github.com/repos/${binding.repository}`;
    const admission = { ...binding, runRepository: binding.repository,
      runId, jobId: 800 + admissions, attempt: 1, invocation: `pause-${admissions}`,
      decision: paused ? 'denied' : 'allowed', code: paused ? 'ISSUE_PAUSED' : '',
      executed: true };
    evidence = { admission, observation: { issue: structuredClone(f.issues.get(29)),
      events: structuredClone(events) }, stageAdmitted: false, createdReceipts: [],
    pause: { status: paused ? 'paused' : 'clear' } };
    f.nativeExecutions.set(runId, {
      run: { id: runId, run_attempt: 1, repository: { full_name: binding.repository },
        url: `${base}/actions/runs/${runId}`,
        status: 'completed', conclusion: 'success' },
      jobs: [{ id: admission.jobId, run_id: runId, run_attempt: 1,
        url: `${base}/actions/jobs/${admission.jobId}`,
        status: 'completed', conclusion: 'success' }],
    });
    return structuredClone(admission);
  };
  f.caller.readPauseEvidence = async () => structuredClone(evidence);
  return { ...f, events, admissions: () => admissions,
    evidence: () => evidence };
}

test('owned pause mutation, native history and Core evidence stay distinct', async t => {
  const f = await fixture(t);
  const result = await runPause('fixture/repository', f.caller);
  assert.equal(result.state, 'passed', JSON.stringify(result));
  assert.equal(result.liveVerified, false);
  assert.equal(f.admissions(), 2);
  assert.deepEqual(f.writes, ['add-issue-label', 'remove-issue-label', 'close-29']);
});

test('missing protected capability cannot become simulated live success', async t => {
  const f = await fixture(t);
  delete f.caller.admitPause;
  assert.equal((await runPause('fixture/repository', f.caller)).state, 'blocked');
  assert.deepEqual(f.writes, []);
  const live = select(scenarios, ['pause']).find(entry => entry.id === 'pause.live');
  const scenario = await import(live.module);
  assert.equal(typeof scenario.prerequisite(), 'string');
  assert.equal(scenario.verify({ state: 'passed' }), false);
});

test('lost admission response retains inventory; only bound reads reconcile', async t => {
  const f = await fixture(t);
  const admit = f.caller.admitPause;
  f.caller.admitPause = async binding => {
    await admit(binding);
    throw new Error('Response lost');
  };
  const result = await runPause('fixture/repository', f.caller);
  assert.equal(result.state, 'unverified');
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(f.admissions(), 1);
  assert.deepEqual(f.writes, ['add-issue-label']);
  const owned = f.owned[0];
  const saved = f.evidence().admission.requestId;
  f.evidence().admission.requestId = 'foreign';
  assert.equal((await reconcilePauseExecution(owned.inventory, f.caller)).state,
    'unverified');
  f.evidence().admission.requestId = saved;
  assert.equal((await reconcilePauseExecution(owned.inventory, f.caller)).state,
    'passing');
  assert.equal(f.admissions(), 1);
  assert.equal((await owned.lifecycle.teardown()).state, 'passing');
});

test('partial, stale, mismatched and caller-only assertions cannot prove admission',
  async t => {
    for (const fault of ['partial', 'stale', 'foreign', 'receipt', 'admitted']) {
      const f = await fixture(t);
      const observe = f.caller.observe;
      f.caller.observe = async target => {
        const value = await observe(target);
        if (target.kind === 'issue-events' && f.events.length) {
          if (fault === 'partial') value.complete = false;
          if (fault === 'stale') value.data = [];
          if (fault === 'foreign') value.target = { ...value.target,
            number: value.target.number + 1 };
        }
        return value;
      };
      const read = f.caller.readPauseEvidence;
      f.caller.readPauseEvidence = async binding => {
        const value = await read(binding);
        if (fault === 'receipt') value.createdReceipts = [{ stage: 'deliver' }];
        if (fault === 'admitted') value.stageAdmitted = true;
        return value;
      };
      assert.equal((await runPause('fixture/repository', f.caller)).state, 'unverified');
      assert.ok(f.admissions() <= 1);
    }
  });
