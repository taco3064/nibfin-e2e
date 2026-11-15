import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateWake } from '../scenarios/shared-issue.mjs';
import { observeLiveWake, mutateAndObserveIssue, enrollAndObserveSharedIssue }
  from '../wake-protected.mjs';
import { wakeFixture } from '../scenarios/wake-fixtures.mjs';
import { sharedIdentityKeys } from '../wake-identities.mjs';
import { githubObserver } from '../github-observer.mjs';

const correlate = f => correlateWake('shared-issue', f.expected, f.evidence, 'fixture');
const options = () => {
  const f = wakeFixture();
  // Simulate the protected operator boundary; this remains a synthetic unit test.
  f.evidence.enrollment.origin = 'operator';
  return { ...f, leg: 'shared-issue', readEvidence: async () => f.evidence,
    observe: async target => Object.values(f.evidence).find(o => o?.target &&
      JSON.stringify(o.target) === JSON.stringify(target)) };
};

test('shared result retains only observed verified OIDC identity fields', () => {
  const f = wakeFixture();
  f.evidence.oidc.token = 'secret';
  f.evidence.oidc.requestToken = 'secret';
  f.evidence.oidc.diagnostic = 'secret';
  const result = correlate(f);
  assert.equal(result.state, 'passed');
  assert.equal(result.mode, 'fixture');
  assert.equal(result.oidc.identityHash, f.evidence.oidc.identityHash);
  assert.equal(result.oidc.repositoryId, 12);
  assert(!JSON.stringify(result).includes('secret'));
  assert.equal(correlateWake('shared-issue', f.expected, f.evidence).state,
    'unverified');
});

for (const key of sharedIdentityKeys) {
  test(`shared ${key} must agree in Core, wake, and authorized expectation`, () => {
    for (const record of ['core', 'wake']) {
      const f = wakeFixture();
      const target = record === 'core' ? f.evidence.core[0] : f.evidence.wake;
      target[key] = typeof target[key] === 'number' ? target[key] + 1 : 'substitute';
      assert.equal(correlate(f).state, 'unverified');
    }
  });
}

test('native identity, source, forwarding, pool and OIDC are required', () => {
  for (const mutate of [
    e => { e.issue.data.node_id = 'other'; },
    e => { e.run.data.repository.id++; },
    e => { e.origin.data.repository.id++; },
    e => { e.origin.data.actor.id++; },
    e => { e.run.data.actor.id++; },
    e => { e.run.data.head_sha = 'f'.repeat(40); },
    e => { e.origin.data.head_sha = 'f'.repeat(40); },
    e => { e.run.data.workflow_id++; },
    e => { e.origin.data.workflow_id++; },
    e => { e.run.data.head_branch = 'old'; },
    e => { e.origin.data.path = 'old.yml'; },
    e => { e.jobs.data[0].check_run_url += '1'; },
    e => { e.jobs.data[0].runner_name = 'other'; },
    e => { e.enrollment.runners[0].id++; },
    e => { e.enrollment.runners[1] = e.enrollment.runners[0]; },
    e => { e.enrollment.callers.execution.sourceCommit = 'f'.repeat(40); },
    e => { e.enrollment.callers.execution.blob = 'f'.repeat(40); },
    e => { e.enrollment.registrationsComplete = false; },
    e => { e.enrollment.targetRunnerCount = 1; },
    e => { e.enrollment.adopted = false; },
    e => { e.enrollment.recoveryPending = true; },
    e => { delete e.enrollment; },
    e => { delete e.forwarding; },
    e => { e.forwarding = [e.forwarding, e.forwarding]; },
    e => { e.forwarding.confirmed = false; },
    e => { e.forwarding.runId++; },
    e => { e.forwarding.attempt++; },
    e => { e.oidc.repositoryId++; },
    e => { e.oidc.actorId++; },
    e => { e.oidc.runId++; },
    e => { e.oidc.attempt++; },
    e => { e.oidc.checkRunId++; },
    e => { e.oidc.jobId++; },
    e => { e.oidc.runnerId++; },
    e => { e.oidc.sourceCommit = 'f'.repeat(40); },
    e => { e.oidc.verified = false; },
    e => { delete e.oidc; },
    e => { e.oidc = [e.oidc, e.oidc]; },
  ]) {
    const f = wakeFixture();
    mutate(f.evidence);
    assert.equal(correlate(f).state, 'unverified');
  }
});

test('origin actor is independent of execution actor and enrolled member', () => {
  const f = wakeFixture();
  f.expected.originActorId = 99;
  f.evidence.origin.data.actor.id = 99;
  for (const record of [f.evidence.core[0], f.evidence.wake,
    f.evidence.route, f.evidence.forwarding]) record.originActorId = 99;
  assert.equal(correlate(f).state, 'passed');
});

test('permission unavailable, confirmed denial, skipped, pending and missing differ',
  async () => {
    const denied = wakeFixture('shared-issue', 'denied');
    assert.equal(correlate(denied).state, 'passed');
    denied.evidence.jobs.data[0].conclusion = 'skipped';
    assert.equal(correlate(denied).state, 'unverified');
    const pending = wakeFixture('shared-issue', 'pending');
    assert.equal(correlate(pending).code, 'CORE_PENDING');
    const f = options();
    f.evidence.permission = 'unavailable';
    assert.equal((await observeLiveWake(f)).code, 'WAKE_PERMISSION_UNAVAILABLE');
    delete f.evidence.permission;
    f.readEvidence = async () => { throw { code: 'WAKE_PERMISSION_DENIED' }; };
    assert.equal((await observeLiveWake(f)).code, 'WAKE_PERMISSION_UNAVAILABLE');
    f.readEvidence = async () => ({ dispatch: 'success' });
    assert.equal((await observeLiveWake(f)).state, 'unverified');
    f.observe = async () => ({ complete: false, reason: 'missing' });
    assert.equal((await observeLiveWake(f)).state, 'unverified');
  });

test('bounded read retries do not repeat Issue mutations or dispatch', async () => {
  const f = options();
  let reads = 0;
  let writes = 0;
  const observe = f.observe;
  f.observe = async target => ++reads <= 4 ? { complete: false } : observe(target);
  const result = await mutateAndObserveIssue({ ...f, maxAttempts: 2,
    lifecycle: { mutateIssue: async () => { writes++; return { state: 'passing' }; } },
    operation: 'edit-issue-body', input: 'synthetic' });
  assert.equal(result.state, 'passed');
  assert.equal(reads, 8);
  assert.equal(writes, 1);
  assert.equal((await observeLiveWake({ ...f, maxAttempts: 11 })).state, 'unverified');
  assert.equal((await observeLiveWake({ ...f, bounds: { requests: 1 } })).state,
    'unverified');
});

test('protected native timeout reaches the provider cancellation signal', async () => {
  const f = options();
  let nativeSignal;
  f.observe = githubObserver(async (_, { signal }) => {
    nativeSignal = signal;
    return new Promise(() => {});
  });
  const result = await observeLiveWake({ ...f, bounds: { requestTimeoutMs: 25 } });
  assert.equal(result.state, 'unverified');
  assert.equal(nativeSignal.aborted, true);
});

test('protected enrollment composition injects its evidence once across read retries',
  async () => {
    const f = options();
    const peer = f.evidence.enrollment;
    delete f.evidence.enrollment;
    let enrollments = 0;
    let reads = 0;
    const observe = f.observe;
    f.observe = async target => ++reads <= 4 ? { complete: false } : observe(target);
    const enrollment = { enroll: async () => { enrollments++; return peer; } };
    assert.equal((await enrollAndObserveSharedIssue({ ...f, enrollment,
      maxAttempts: 2 })).state, 'passed');
    assert.equal(enrollments, 1);
    assert.equal(reads, 8);
    peer.origin = 'synthetic';
    f.readEvidence = () => assert.fail('synthetic enrollment cannot observe live');
    assert.equal((await enrollAndObserveSharedIssue({ ...f, enrollment })).state,
      'unverified');
    enrollment.enroll = async () => { throw new Error('secret'); };
    const failure = await enrollAndObserveSharedIssue({ ...f, enrollment });
    assert.equal(failure.state, 'unverified');
    assert(!JSON.stringify(failure).includes('secret'));
  });
