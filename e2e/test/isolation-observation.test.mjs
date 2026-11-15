import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { compareAdmission, admissionCases, canaryCases } from
  '../isolation-contract.mjs';
import { exerciseSyntheticCanaries, syntheticCanaryProbe } from
  '../isolation-canaries.mjs';
import { disposableSentinels } from '../isolation-sentinels.mjs';
import { isolationFixture } from './isolation-observation-fixture.mjs';

for (const name of admissionCases) {
  test(`${name} preserves expected and actual native identities`, async t => {
    const f = await isolationFixture(t);
    f.expected.case = name;
    f.observed.rejection.category = name;
    const result = compareAdmission(f.expected, f.observed);
    assert.equal(result.state, 'synthetic');
    assert.deepEqual(result.expected, result.actual);
    assert.equal(result.case, name);
    f.expected.negative.workflowId++;
    assert.equal(compareAdmission(f.expected, f.observed).state, 'unverified');
  });
}
for (const name of ['fork', 'route']) {
  test(`${name} inapplicability never counts as rejection`, async t => {
    const f = await isolationFixture(t);
    f.expected.case = name;
    f.expected.applicable = false;
    assert.equal(compareAdmission(f.expected, f.observed).state, 'inapplicable');
    assert.equal((await f.run()).state, 'inapplicable');
    assert.deepEqual(f.events, []);
  });
}
const mutations = {
  'missing steps': o => { delete o.negative.jobs.data[0].steps; },
  'null steps': o => { o.negative.jobs.data[0].steps = null; },
  'ambiguous steps': o => { o.negative.jobs.data[0].steps = [{}]; },
  'skipped steps': o => { o.negative.jobs.data[0].steps = [{
    status: 'completed', conclusion: 'skipped' }]; },
  'incomplete jobs': o => { o.negative.jobs.complete = false; },
  'missing job': o => { o.negative.jobs.data = []; },
  'duplicate job': o => { o.negative.jobs.data.push(o.negative.jobs.data[0]); },
  'wrong attempt': o => { o.negative.run.data.run_attempt++; },
  'wrong runner': o => { o.negative.jobs.data[0].runner_id++; },
  'wrong job': o => { o.negative.jobs.data[0].id++; },
  'wrong source': o => { o.negative.run.data.head_sha = 'b'.repeat(40); },
  'wrong workflow': o => { o.negative.run.data.workflow_id++; },
  'wrong route': o => { o.negative.run.data.repository.full_name = 'other/repo'; },
  'wrong fork': o => { o.negative.run.data.head_repository.full_name = 'fork/repo'; },
  'unclassified failure': o => { delete o.rejection; },
  'unverified denial': o => { o.rejection.verified = false; },
  'wrong category': o => { o.rejection.category = 'wrong-source'; },
  'unrelated rejection': o => { o.rejection.assignment.jobId++; },
  'missing inspection': o => { delete o.negativeSentinel; },
  'stale sentinel': o => { o.negativeSentinel.nonce = 'stale'; },
  'unrelated recovery sentinel': o => { o.eligibleSentinel.run = 'other'; },
  'unrelated recovery slot': o => { o.eligibleSlot.slotId = 'slot-2'; },
  'unrelated recovery runner': o => { o.eligible.jobs.data[0].runner_id++; },
  'early recovery': o => { o.eligible.jobs.data[0].started_at =
    '2026-11-15T01:00:00Z'; },
  'recovery without execution': o => { o.eligible.jobs.data[0].steps = []; },
  'recovery without sentinel': o => { o.eligibleSentinel.state = 'absent'; },
  'uncertain cleanup': o => { o.cleaned = false; },
  'uncertain termination': o => { o.terminated = false; },
  'skipped job': o => { o.negative.jobs.data[0].conclusion = 'skipped'; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`${name} cannot establish rejection and recovery`, async t => {
    const f = await isolationFixture(t);
    mutate(f.observed);
    assert.equal(compareAdmission(f.expected, f.observed).state, 'unverified');
  });
}
test('executed negative steps and owned sentinel presence contradict rejection',
  async t => {
    const f = await isolationFixture(t);
    f.observed.negative.jobs.data[0].steps = [{ status: 'completed',
      conclusion: 'failure', started_at: '2026-11-15T01:00:00Z' }];
    assert.equal(compareAdmission(f.expected, f.observed).state, 'failing');
    f.observed.negative.jobs.data[0].steps = [];
    f.observed.negativeSentinel.state = 'present';
    assert.equal(compareAdmission(f.expected, f.observed).state, 'failing');
  });

test('protected adapter acquires native reads and owns cleanup; stays synthetic',
  async t => {
    const f = await isolationFixture(t);
    const result = await f.run();
    assert.equal(result.state, 'synthetic');
    assert.deepEqual(f.events, ['authorize', 'open', 'negative', 'eligible',
      'terminate']);
    assert.equal(f.installation.protectedExecution, 'unverified');
    assert.equal((await f.run({ mode: 'live' })).state, 'unverified');
  });
for (const condition of ['missing-caller', 'unauthorized', 'producer-binding',
  'producer-source', 'producer-registration', 'producer-inventory', 'pending']) {
  test(`${condition} prevents protected operations`, async t => {
    const f = await isolationFixture(t);
    if (condition === 'unauthorized') f.caller.authorize = async () => false;
    if (condition === 'producer-binding') f.installation.observation.binding.hostId =
      'different';
    if (condition === 'producer-source') f.installation.observation.sources.core = {};
    if (condition === 'producer-registration') {
      f.installation.observation.runners[0].localId++;
    }
    if (condition === 'producer-inventory') f.installation.inventory.hostId = 'other';
    if (condition === 'pending') f.installation.inventory.pending = { sequence: 1 };
    const result = await f.run(condition === 'missing-caller' ? { caller: null } : {});
    assert.equal(result.state, 'unverified');
    assert(!f.events.includes('open'));
    assert(!f.events.includes('terminate'));
  });
}
for (const condition of ['exception', 'timeout', 'termination', 'cleanup',
  'executed', 'truncated', 'sentinel']) {
  test(`${condition} native acquisition cannot pass or expose diagnostics`, async t => {
    const f = await isolationFixture(t);
    if (condition === 'exception') f.caller.executeNegative = async () => {
      throw new Error('private credential bytes');
    };
    if (condition === 'timeout') f.caller.executeNegative = () => new Promise(() => {});
    if (condition === 'termination') f.caller.terminate = async () => false;
    if (condition === 'cleanup') {
      const open = f.caller.openSurface;
      f.caller.openSurface = async () => {
        const surface = await open();
        surface.cleanup = async () => { throw new Error('private credential bytes'); };
        return surface;
      };
    }
    if (condition === 'executed') f.observed.negative.jobs.data[0].steps = [{
      status: 'completed', conclusion: 'failure' }];
    if (condition === 'truncated') {
      const provider = f.caller.provider;
      f.caller.provider = async url => {
        const response = await provider(url);
        if (url.includes('/jobs?')) response.data.total_count++;
        return response;
      };
    }
    if (condition === 'sentinel') {
      const open = f.caller.openSurface;
      let surface;
      f.caller.openSurface = async () => { surface = await open(); return surface; };
      f.caller.executeNegative = ({ sentinel }) => surface.write(sentinel);
    }
    const result = await f.run({ bounds: { requestTimeoutMs: 50 } });
    assert(!['passed', 'synthetic'].includes(result.state));
    assert(!JSON.stringify(result).includes('private'));
    if (condition !== 'termination') assert(f.events.includes('terminate'));
  });
}

test('sentinels enforce ownership, unique runs, exact content and safe inspection',
  async t => {
    const surface = await disposableSentinels('/tmp');
    t.after(() => surface.cleanup());
    const a = surface.reserve('one');
    const b = surface.reserve('two');
    assert.notEqual(a.nonce, b.nonce);
    assert.throws(() => surface.reserve('one'));
    assert.throws(() => surface.target({ ...a }));
    assert.equal((await surface.inspect(a)).state, 'absent');
    await surface.write(a);
    assert.equal((await surface.inspect(a)).state, 'present');
    await writeFile(surface.target(a), 'stale');
    assert.equal((await surface.inspect(a)).state, 'unknown');
    await symlink(surface.target(a), surface.target(b));
    assert.equal((await surface.inspect(b)).state, 'unknown');
    await surface.cleanup();
    assert.throws(() => surface.reserve('three'));
    await assert.rejects(surface.inspect(a));
  });
test('all five canaries exercise only synthetic surfaces and sanitize output',
  async () => {
    const denied = await exerciseSyntheticCanaries();
    assert.deepEqual(denied.map(r => r.case), canaryCases);
    assert(denied.every(r => r.mode === 'synthetic' && r.state === 'expected-denial'));
    const mixed = await exerciseSyntheticCanaries(syntheticCanaryProbe({
      accessible: ['docker'], unavailable: ['egress'],
    }));
    assert.equal(mixed.find(r => r.case === 'docker').state, 'unexpected-access');
    assert.equal(mixed.find(r => r.case === 'egress').state, 'unavailable');
    const errors = await exerciseSyntheticCanaries(async () => {
      throw new Error('denied private credential bytes');
    });
    assert(errors.every(r => r.state === 'unavailable'));
    assert(!JSON.stringify(errors).includes('private'));
  });

test('late negative writes are inspected after termination before cleanup', async t => {
  const f = await isolationFixture(t);
  const open = f.caller.openSurface;
  let surface;
  let negative;
  f.caller.openSurface = async () => { surface = await open(); return surface; };
  f.caller.executeNegative = ({ sentinel }) => { negative = sentinel; };
  const terminate = f.caller.terminate;
  f.caller.terminate = async () => {
    await surface.write(negative);
    return terminate();
  };
  assert.equal((await f.run()).code, 'NEGATIVE_SENTINEL_PRESENT');
});

test('canary timeouts remain bounded and unavailable', async () => {
  const result = await exerciseSyntheticCanaries(() => new Promise(() => {}), {
    requestTimeoutMs: 5,
  });
  assert(result.every(row => row.state === 'unavailable'));
});
