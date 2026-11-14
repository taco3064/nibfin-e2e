import test from 'node:test';
import assert from 'node:assert/strict';
import { runDelivery } from '../delivery-protected.mjs';
import { capabilityNames } from '../delivery-contract.mjs';
import { protectedFixture } from './delivery-support.mjs';

const request = { repository: 'fixture/repository', path: 'answer.txt',
  content: '42\n' };

test('fresh protected composition preserves provenance and cleans up', async () => {
  const fixture = protectedFixture();
  const result = await runDelivery(request, fixture.caller);
  assert.deepEqual(result, { state: 'passed', mode: 'fixture', liveVerified: false,
    code: 'FIXTURE_CONTRACT_CONFIRMED' });
  assert.deepEqual(fixture.counts(), { setups: 1, cleanups: 1 });
  const previous = fixture.binding();
  await runDelivery(request, fixture.caller);
  assert.notEqual(previous.requestId, fixture.binding().requestId);
  assert.notEqual(previous.path, fixture.binding().path);
});

test('missing capabilities block before external effects', async () => {
  for (const name of capabilityNames) {
    const fixture = protectedFixture();
    delete fixture.caller[name];
    const result = await runDelivery(request, fixture.caller);
    assert.equal(result.state, 'blocked');
    assert.equal(result.capability, name);
    assert.equal(fixture.counts().setups, 0);
  }
});

test('unsafe requests cannot create fixtures', async () => {
  for (const path of ['../escape', '/absolute', 'a/../../b', 'a\\b', '.']) {
    const fixture = protectedFixture();
    assert.equal((await runDelivery({ ...request, path }, fixture.caller)).state,
      'blocked');
    assert.equal(fixture.counts().setups, 0);
  }
});

const mutations = {
  'missing stage': e => e.stages.pop(),
  'duplicate stage': e => { e.stages[1] = e.stages[0]; },
  'prior request': e => { e.stages[0].requestId = 'previous'; },
  'wrong Issue': e => { e.stages[0].issue++; },
  'wrong repository': e => { e.stages[0].repository = 'other/repository'; },
  'wrong Run': e => { e.stages[0].admission = { ...e.admissions[0], runId: 999 }; },
  'wrong attempt': e => { e.stages[0].admission = { ...e.admissions[0], attempt: 9 }; },
  'wrong Job': e => { e.stages[0].admission = { ...e.admissions[0], jobId: 9 }; },
  'wrong head': e => { e.stages[8].head = 'd'.repeat(40); },
  'wrong PR': e => { e.stages[8].pull++; },
  'wrong Candidate': e => { e.stages[5].candidate = 'other'; },
  'wrong Shape': e => { e.stages[1].shape = 'other'; },
  'empty Candidate': e => { e.candidate.substantive = false; },
  'escaped Candidate': e => { e.candidate.paths.push('e2e/worker.mjs'); },
  'missing Agent': e => { e.stages[0].agentExecuted = false; },
  'missing Runner': e => { e.stages[3].runnerExecuted = false; },
  'reused execution': e => { e.stages[1].execution.id = e.stages[0].execution.id; },
  'reused session': e => {
    e.stages[5].execution.sessionId = e.stages[3].execution.sessionId;
  },
  'missing pre hook': e => { e.stages[4].hooks = []; },
  'missing post hook': e => { e.stages[6].hooks = []; },
  'unsupported hook': e => { e.candidate.hooks[0].event = 'pre-push'; },
  'generic hook success': e => { delete e.stages[4].hooks[0].executed; },
  'skipped hook': e => { e.stages[6].hooks[0].outcome = 'skipped'; },
  'duplicate admission': e => { e.admissions.push(e.admissions[0]); },
  'unsupported artifact': e => {
    e.candidate.artifacts = [{ path: 'external-report', purpose: 'required' }];
  },
  'missing checks': e => { e.pull.checkIds = []; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`delivery rejects ${name}`, async () => {
    const fixture = protectedFixture(mutate);
    const result = await runDelivery(request, fixture.caller);
    assert.equal(result.state, 'unverified');
    assert.equal(result.liveVerified, false);
    assert.equal(fixture.counts().cleanups, 1);
  });
}

test('known stage and source failures remain distinct', async () => {
  const stage = protectedFixture(e => { e.stages[5].outcome = 'failure'; });
  assert.equal((await runDelivery(request, stage.caller)).code, 'STAGE_FAILED');
  const source = protectedFixture();
  source.caller.assertSource = async () => ({ state: 'contradicted' });
  const result = await runDelivery(request, source.caller);
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'SOURCE_BEHAVIOR_FAILED');
});

test('native checks, merge, closure and source must agree', async () => {
  for (const mutate of [
    o => { if (o.target.kind === 'checks') o.data[0].conclusion = 'skipped'; },
    o => { if (o.target.kind === 'checks') o.data[0].status = 'queued'; },
    o => { if (o.target.kind === 'checks') o.data[0].head_sha = 'd'.repeat(40); },
    o => { if (o.target.kind === 'pull') o.data.head.sha = 'd'.repeat(40); },
    o => { if (o.target.kind === 'pull') o.data.merged = false; },
    o => {
      if (o.target.kind === 'pull') o.data.merge_commit_sha = 'd'.repeat(40);
    },
    o => { if (o.target.kind === 'issue') o.data.state = 'open'; },
    o => { if (o.target.kind === 'issue') o.data.labels = []; },
  ]) {
    const fixture = protectedFixture();
    const observe = fixture.caller.observe;
    fixture.caller.observe = async target => {
      const value = await observe(target);
      // Wake must complete before evaluating terminal delivery observations.
      if (['checks', 'pull'].includes(target.kind) || value?.data?.state) mutate(value);
      return value;
    };
    assert.equal((await runDelivery(request, fixture.caller)).state, 'unverified');
  }
  const fixture = protectedFixture();
  fixture.caller.assertSource = async value => ({ ...value, state: 'satisfied',
    mergeCommit: 'd'.repeat(40) });
  assert.equal((await runDelivery(request, fixture.caller)).state, 'unverified');
});

test('unknown trigger is not retried or exposed in diagnostics', async () => {
  const fixture = protectedFixture();
  let triggers = 0;
  fixture.caller.trigger = async () => { triggers++; throw new Error('secret'); };
  const result = await runDelivery(request, fixture.caller);
  assert.equal(result.code, 'TRIGGER_EFFECT_UNKNOWN');
  assert.equal(triggers, 1);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(fixture.counts().cleanups, 1);
});

test('empty hook phases require actual empty obligations', async () => {
  const fixture = protectedFixture(e => {
    e.candidate.hooks = [];
    e.stages[4].hooks = [];
    e.stages[6].hooks = [];
  });
  assert.equal((await runDelivery(request, fixture.caller)).state, 'passed');
});

test('multiple native admissions must remain explicitly associated', async () => {
  const fixture = protectedFixture(e => {
    const next = { ...e.admissions[0], runId: 201, attempt: 1, jobId: 301 };
    e.admissions.push(next);
    for (const stage of e.stages.slice(3)) stage.admission = next;
  });
  const observe = fixture.caller.observe;
  fixture.caller.observe = async target => {
    if (target.runId !== 201) return observe(target);
    const old = await observe({ ...target, runId: 200, attempt: 2 });
    const data = structuredClone(old.data);
    const base = `https://api.github.com/repos/${target.repository}`;
    if (target.kind === 'run') {
      data.id = 201;
      data.run_attempt = 1;
      data.url = `${base}/actions/runs/201`;
    } else {
      data[0].id = 301;
      data[0].run_id = 201;
      data[0].run_attempt = 1;
      data[0].url = `${base}/actions/jobs/301`;
    }
    return { complete: true, target, data };
  };
  assert.equal((await runDelivery(request, fixture.caller)).state, 'passed');
});

test('prior successful delivery evidence cannot satisfy a fresh request', async () => {
  const fixture = protectedFixture();
  const read = fixture.caller.readDeliveryEvidence;
  let old;
  fixture.caller.readDeliveryEvidence = async binding => {
    old ??= await read(binding);
    return old;
  };
  assert.equal((await runDelivery(request, fixture.caller)).state, 'passed');
  const result = await runDelivery(request, fixture.caller);
  assert.equal(result.state, 'unverified');
  assert.equal(result.liveVerified, false);
});

test('known failing CI is distinct from unavailable or skipped CI', async () => {
  const fixture = protectedFixture();
  const observe = fixture.caller.observe;
  fixture.caller.observe = async target => {
    const value = await observe(target);
    if (target.kind === 'checks') value.data[0].conclusion = 'failure';
    return value;
  };
  const result = await runDelivery(request, fixture.caller);
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'NATIVE_CI_FAILED');
});

test('a reused inventory definition cannot satisfy fresh setup', async () => {
  const fixture = protectedFixture();
  const create = fixture.caller.createFixture;
  fixture.caller.createFixture = async definition => {
    const owned = await create(definition);
    owned.definition = { ...definition, owner: 'old-owner' };
    return owned;
  };
  const result = await runDelivery(request, fixture.caller);
  assert.equal(result.state, 'unverified');
  assert.equal(fixture.counts().setups, 0);
});
