import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeliveryPair, javascriptRequests } from '../delivery-pair.mjs';
import { pairedFixture } from './delivery-pair-support.mjs';

const request = { repository: 'fixture/repository',
  assignee: { id: 7, login: 'target-actor' } };

test('paired JavaScript delivery dispatches both and keeps non-live provenance',
  async () => {
    const f = pairedFixture();
    const result = await runDeliveryPair(request, f.caller);
    assert.equal(result.state, 'passed', JSON.stringify(result));
    assert.equal(result.liveVerified, false);
    assert.equal(result.mode, 'fixture');
    assert.deepEqual(f.events, ['prepare:0', 'prepare:1', 'trigger:0', 'trigger:1',
      'read:0', 'read:1', 'cleanup:1', 'cleanup:0']);
    assert.notEqual(f.legs[0].definition.owner, f.legs[1].definition.owner);
    assert.notEqual(f.legs[0].binding.requestId, f.legs[1].binding.requestId);
    assert.notEqual(f.legs[0].binding.path, f.legs[1].binding.path);
    f.legs.forEach((leg, index) => {
      assert.equal(leg.binding.content, javascriptRequests[index].content);
      assert.equal(leg.binding.stdout, javascriptRequests[index].stdout);
      assert.deepEqual(leg.assignee, request.assignee);
      assert.match(leg.body, /no dependency/);
    });
  });

const mutations = {
  'missing stage': (kind, e) => { if (kind === 'delivery') e.stages.pop(); },
  'cross repository': (kind, e) => {
    if (kind === 'delivery') e.stages[0].repository = 'other/repository';
  },
  'reused session across Issues': (kind, e) => {
    if (kind === 'delivery') e.stages[0].execution.sessionId = 'same-session';
  },
  'reused Candidate across Issues': (kind, e) => {
    if (kind === 'delivery') {
      e.candidate.id = 'same-candidate';
      e.stages.forEach(s => { s.candidate = 'same-candidate'; });
    }
  },
  'missing isolation': (kind, e) => { if (kind === 'isolation') delete e.result; },
  'isolation from another Runner': (kind, e) => {
    if (kind === 'isolation') e.result.actual.runnerId++;
  },
  'isolation from another repository': (kind, e) => {
    if (kind === 'isolation') e.result.actual.repository = 'other/repository';
  },
  'no concurrency': (kind, e) => { if (kind === 'history') e.progress = []; },
  'missing history': (kind, e) => { if (kind === 'history') delete e.coverage; },
  'wrong Writer': (kind, e) => {
    if (kind === 'history') e.writers[0].executionId = 'other-writer';
  },
  'stale PR head': (kind, e) => {
    if (kind === 'native' && e.target.kind === 'pull') e.data.head.sha = 'stale';
  },
  'omitted failing check': (kind, e) => {
    if (kind === 'native' && e.target.kind === 'checks') {
      e.data.push({ ...e.data[0], id: 99, conclusion: 'failure',
        url: `https://api.github.com/repos/${e.target.repository}/check-runs/99` });
    }
  },
  'incorrect stdout': (kind, e) => { if (kind === 'source') e.stdout = 'wrong\n'; },
  'repeated stdout': (kind, e) => { if (kind === 'source') e.stdout += e.stdout; },
  'unclean source': (kind, e) => {
    if (kind === 'source') e.checkout.clean = false;
  },
  'stale source': (kind, e) => {
    if (kind === 'source') e.checkout.commit = 'a'.repeat(40);
  },
};
for (const [name, edit] of Object.entries(mutations)) {
  test(`paired delivery rejects ${name}`, async () => {
    const f = pairedFixture(edit);
    const result = await runDeliveryPair(request, f.caller);
    assert.notEqual(result.state, 'passed', JSON.stringify(result));
    assert.equal(result.liveVerified, false);
  });
}

test('missing capabilities and preparation block before triggering', async () => {
  const f = pairedFixture();
  delete f.caller.readConcurrencyEvidence;
  assert.equal((await runDeliveryPair(request, f.caller)).state, 'blocked');
  assert.equal(f.legs.length, 0);
  const second = pairedFixture();
  const create = second.caller.createFixture;
  second.caller.createFixture = async definition => {
    const fixture = await create(definition);
    fixture.lifecycle.prepareDelivery = async () => ({ state: 'unverified' });
    return fixture;
  };
  assert.notEqual((await runDeliveryPair(request, second.caller)).state, 'passed');
  assert.equal(second.events.some(e => e.startsWith('trigger:')), false);
});

test('unknown trigger is retained without replay or destructive cleanup', async () => {
  const f = pairedFixture();
  let calls = 0;
  f.caller.trigger = async () => { calls++; throw new Error('private'); };
  const result = await runDeliveryPair(request, f.caller);
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(result.code, 'TRIGGER_EFFECT_UNKNOWN');
  assert.equal(calls, 1);
  assert.equal(f.events.some(e => e.startsWith('cleanup:')), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
