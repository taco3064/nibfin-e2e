import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateWake, correlateNoAssignee } from '../wake-correlation.mjs';
import { observeLiveWake, mutateAndObserveIssue } from '../wake-protected.mjs';
import { wakeFixture } from '../scenarios/wake-fixtures.mjs';
import { exercise, verify } from '../scenarios/wake-contract.mjs';
import { fixture } from './fixture-support.mjs';
import { fixtureGithub } from '../fixture-github.mjs';
import { fixtureBudget } from '../fixture-budget.mjs';

for (const leg of ['shared-issue', 'action']) {
  test(`${leg} controlled scenario executes positive and negative assertions`, () => {
    assert.equal(verify(exercise(leg)), true);
  });
  test(`${leg} rejects native and cross-record mismatches`, () => {
    const status = leg === 'action' ? 'denied' : 'completed';
    const mutations = [
      e => { e.issue.data.number++; },
      e => { e.run.data.id++; },
      e => { e.run.data.repository.full_name = 'other/repo'; },
      e => { e.run.data.run_attempt++; },
      e => { e.jobs.data[0].run_id++; },
      e => { e.jobs.data[0].run_attempt++; },
      e => { e.jobs.data[0].id++; },
      e => { e.jobs.data.push(structuredClone(e.jobs.data[0])); },
      e => { e.core[0].receiptHash = status === 'denied' ? 'a' : ''; },
      e => { e.run.complete = false; e.run.reason = 'denied'; },
      e => { e.jobs.data[0].status = 'queued'; },
      e => { e.core = []; },
    ];
    for (const mutate of mutations) {
      const { expected, evidence } = wakeFixture(leg, status);
      mutate(evidence);
      assert.equal(correlateWake(leg, expected, evidence).state, 'unverified');
    }
  });
}

test('shared routing responses, duplicate wakes and wrong Runner cannot pass', () => {
  for (const mutate of [
    e => { e.wake.originRunId++; }, e => { e.wake.originAttempt++; },
    e => { e.route.issue++; }, e => { e.route.reusableWorkflow = 'other'; },
    e => { e.origin.data.event = 'workflow_dispatch'; },
    e => { e.run.data.path = 'other.yml'; },
    e => { e.jobs.data[0].runner_id++; },
    e => { e.jobs.data[0].labels = []; },
    e => { e.jobs.data[0].conclusion = 'skipped'; },
    e => { e.run.data.conclusion = 'failure'; },
    e => { e.wake = [e.wake, e.wake]; },
    e => { delete e.core; },
  ]) {
    const { expected, evidence } = wakeFixture();
    mutate(evidence);
    assert.equal(correlateWake('shared-issue', expected, evidence).state, 'unverified');
  }
});

test('Action identity, outputs, step execution and denial contract must agree', () => {
  for (const mutate of [
    e => { delete e.action; }, e => { e.action.stage = 'deliver'; },
    e => { e.action.jobId++; }, e => { e.action.invocation = 'other'; },
    e => { e.action.stepNumber++; }, e => { e.action.actionRef = 'other'; },
    e => { e.jobs.data[0].steps = [null]; },
    e => { e.action.outputs.status = 'completed'; },
    e => { e.action.outputs.code = 'OTHER'; },
    e => { e.action.outputs['receipt-hash'] = 'a'.repeat(64); },
    e => { e.jobs.data[0].steps[0].conclusion = 'skipped'; },
  ]) {
    const { expected, evidence } = wakeFixture('action', 'denied');
    mutate(evidence);
    assert.equal(correlateWake('action', expected, evidence).state, 'unverified');
  }
  const { expected, evidence } = wakeFixture('action');
  assert.equal(correlateWake('action', expected, evidence).state, 'unverified');
  for (const value of [expected, evidence.core[0], evidence.action]) {
    value.stage = 'deliver';
  }
  assert.equal(correlateWake('action', expected, evidence).state, 'passed');
  evidence.core[0].status = expected.status = 'pending';
  evidence.core[0].receiptHash = '';
  evidence.action.outputs.status = 'pending';
  evidence.action.outputs['receipt-hash'] = '';
  assert.equal(correlateWake('action', expected, evidence).state, 'unverified');
  assert.equal(correlateNoAssignee(expected, {}).state, 'unverified');
});

test('protected composition uses native reads and does not pass unavailable evidence',
  async () => {
    const { expected, evidence } = wakeFixture();
    const observe = async target => Object.values(evidence).find(value =>
      value?.target && JSON.stringify(value.target) === JSON.stringify(target));
    const result = await observeLiveWake({ leg: 'shared-issue', expected, observe,
      readEvidence: async () => evidence });
    assert.equal(result.state, 'passed');
    assert.equal(result.mode, 'live');
    const unavailable = await observeLiveWake({ leg: 'shared-issue', expected,
      observe, readEvidence: async () => { throw new Error('PRIVATE'); } });
    assert.equal(unavailable.state, 'unverified');
    assert.ok(!JSON.stringify(unavailable).includes('PRIVATE'));
    const timeout = await observeLiveWake({ leg: 'action', expected, observe,
      readEvidence: () => new Promise(() => {}), bounds: { requestTimeoutMs: 5 } });
    assert.equal(timeout.state, 'unverified');
  });

test('owned Issue mutations authorize, preserve marker, and read native effects',
  async t => {
    const f = await fixture(t);
    await f.lifecycle().setup('issue');
    const authorizations = [];
    f.context.authorize = async ({ operation }) => {
      authorizations.push(operation);
      return true;
    };
    f.api.mutateIssue = async record => {
      const native = f.resources.get(record.native.id);
      if (record.mutation.body) native.body = record.mutation.body;
      else native.labels = record.mutation.kind === 'add-issue-label'
        ? [{ name: 'unrelated' }, { name: record.mutation.label }]
        : [{ name: 'unrelated' }];
    };
    for (const [operation, input] of [
      ['edit-issue-body', 'New requirements'], ['add-issue-label', 'scope'],
      ['remove-issue-label', 'scope'],
    ]) {
      const result = await f.lifecycle().mutateIssue(operation, input);
      assert.equal(result.state, 'passing');
      assert.ok(f.resources.values().next().value.body.includes(f.definition.marker));
    }
    assert.deepEqual(authorizations,
      ['edit-issue-body', 'add-issue-label', 'remove-issue-label']);
    f.context.authorize = async () => false;
    assert.equal((await f.lifecycle().mutateIssue('edit-issue-body', 'x')).state,
      'unverified');
  });

test('unknown mutation blocks further writes and cleanup until exact reconciliation',
  async t => {
    const f = await fixture(t);
    await f.lifecycle().setup('issue');
    let writes = 0;
    let record;
    f.api.mutateIssue = async value => {
      writes++;
      record = value;
      throw new Error('PRIVATE');
    };
    const failed = await f.lifecycle().mutateIssue('edit-issue-body', 'new');
    assert.equal(failed.state, 'unverified');
    assert.ok(failed.resources[0].mutation);
    assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
    assert.equal((await f.lifecycle().mutateIssue('add-issue-label', 'scope')).state,
      'unverified');
    assert.equal((await f.lifecycle().teardown()).state, 'unverified');
    assert.equal((await f.lifecycle().reconcile()).state, 'unverified');
    assert.equal(writes, 1);
    f.resources.get(record.native.id).body = record.mutation.body;
    f.context.idle = async () => false;
    assert.equal((await f.lifecycle().reconcile()).state, 'unverified');
    f.context.idle = async () => true;
    assert.equal((await f.lifecycle().reconcile()).state, 'passing');
    assert.equal((await f.lifecycle().teardown()).state, 'passing');
  });

test('mutation target mismatch and invalid input cannot write or observe a wake',
  async t => {
    const f = await fixture(t);
    await f.lifecycle().setup('issue');
    f.api.mutateIssue = () => assert.fail('must not write');
    for (const [operation, input] of [['close-issue', 'x'],
      ['edit-issue-body', null], ['add-issue-label', 'bad/label']]) {
      assert.equal((await f.lifecycle().mutateIssue(operation, input)).state,
        'unverified');
    }
    const { expected } = wakeFixture();
    const result = await mutateAndObserveIssue({ lifecycle: f.lifecycle(),
      expected, operation: 'edit-issue-body', input: 'new',
      readEvidence: () => assert.fail('must not observe') });
    assert.equal(result.state, 'unverified');
  });

test('REST adapter limits body and label writes to exact Issue endpoints', async () => {
  const calls = [];
  const api = fixtureGithub({ token: 'SYNTHETIC', fetcher: async (url, init) => {
    calls.push({ url, ...init });
    return { status: 204, headers: { get: () => null } };
  } })(fixtureBudget(), { repository: 'fixture/repository' });
  for (const mutation of [
    { kind: 'edit-issue-body', body: 'new' },
    { kind: 'add-issue-label', label: 'scope' },
    { kind: 'remove-issue-label', label: 'scope' },
  ]) await api.mutateIssue({ native: { number: 29 }, mutation });
  assert.deepEqual(calls.map(call => call.method), ['PATCH', 'POST', 'DELETE']);
  assert.ok(calls[0].url.endsWith('/issues/29'));
  assert.deepEqual(JSON.parse(calls[0].body), { body: 'new' });
  assert.deepEqual(JSON.parse(calls[1].body), { labels: ['scope'] });
  assert.ok(calls[2].url.endsWith('/issues/29/labels/scope'));
});

test('protected owned mutation and separate wake observation compose end to end',
  async t => {
    const f = await fixture(t);
    const setup = await f.lifecycle().setup('issue');
    const issue = setup.resources[0].native;
    const { expected, evidence } = wakeFixture('shared-issue', 'completed', {
      repository: f.definition.repository, issue: issue.number,
    });
    let writes = 0;
    f.api.mutateIssue = async record => {
      writes++;
      f.resources.get(record.native.id).body = record.mutation.body;
    };
    const options = { lifecycle: f.lifecycle(), expected,
      operation: 'edit-issue-body', input: 'Updated controlled Issue',
      readEvidence: async () => evidence,
      observe: async target => Object.values(evidence).find(value => value?.target &&
        JSON.stringify(value.target) === JSON.stringify(target)),
    };
    assert.equal((await mutateAndObserveIssue(options)).state, 'passed');
    assert.equal(writes, 1);
    options.observe = async () => ({ complete: false, reason: 'missing' });
    assert.equal((await mutateAndObserveIssue(options)).state, 'unverified');
    assert.equal(writes, 2);
  });
