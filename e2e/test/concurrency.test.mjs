import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, assertConcurrency } from '../concurrency-assertions.mjs';
import { concurrencyFixture } from '../scenarios/concurrency-fixtures.mjs';
import { withDeliverySources } from '../delivery-sources.mjs';
import { runConcurrency } from '../concurrency-protected.mjs';

for (const kind of cases) {
  test(`${kind}: synthetic positive and missing coverage`, () => {
    const { binding, evidence } = concurrencyFixture(kind);
    assert.equal(assertConcurrency(binding, evidence).state, 'passed');
    delete evidence.coverage;
    assert.equal(assertConcurrency(binding, evidence).state, 'unverified');
  });
}
function check(kind, edit, expected, code) {
  const { binding, evidence } = concurrencyFixture(kind);
  edit(evidence, binding);
  const result = assertConcurrency(binding, evidence);
  assert.equal(result.state, expected);
  if (code) assert.equal(result.code, code);
}

test('capacity, eligibility and paired unfinished progress are necessary', () => {
  for (const edit of [e => { e.capacity = 1; }, e => { delete e.capacity; },
    e => { e.independentEligible = false; }, e => { e.progress = []; },
    e => { e.progress[0].at = 10; }]) check('independent', edit, 'unverified');
  check('independent', e => {
    e.progress[0].unfinishedUntil = 4;
    e.progress[1].at = 5;
  }, 'failed', 'GLOBAL_BARRIER_OBSERVED');
});

test('distinct active Writers fail; repeated observations are one execution', () => {
  check('duplicate', e => e.writers.push({ ...e.writers[0] }), 'passed');
  check('duplicate', e => e.writers.push({ ...e.writers[0], executionId: 'other' }),
    'failed', 'OVERLAPPING_WRITERS');
  check('duplicate', e => e.writers.push({ ...e.writers[0], start: 2 }),
    'unverified');
  check('duplicate', e => e.admissions.push({ ...e.admissions[0] }), 'unverified');
  check('duplicate', e => { e.writers = []; }, 'unverified');
  check('duplicate', e => { e.wakes[1].admissions = []; }, 'unverified');
  check('duplicate', e => { e.writers[0].runnerId++; }, 'unverified');
  check('duplicate', e => { e.writers[0].attempt++; }, 'unverified');
  check('duplicate', e => { e.requestId = 'different'; }, 'unverified');
  check('duplicate', (e, b) => { b.wakes = []; }, 'unverified');
});

test('duplicate wakes need lifecycle coverage through termination or window end', () => {
  check('duplicate', e => {
    e.writers[0].activeUntil = 3;
    e.writers[0].end = null;
    e.writers.push({ ...e.writers[0], executionId: 'replacement',
      start: 5, activeUntil: 9, end: 9 });
  }, 'unverified', 'COMPLETE_PROTECTED_HISTORY_REQUIRED');
  check('duplicate', e => {
    e.writers[0].end = null;
  }, 'unverified', 'COMPLETE_PROTECTED_HISTORY_REQUIRED');
  check('duplicate', e => {
    e.writers[0].end = null;
    e.writers[0].activeUntil = e.coverage.end;
  }, 'passed');
});

test('interrupted recovery retains the selected member binding', () => {
  check('interrupted', e => {
    e.admissions[1].memberId++;
    e.writers[1].memberId++;
  }, 'failed', 'CROSS_MEMBER_ADMISSION');
  check('interrupted', (e, b) => { delete b.memberId; },
    'unverified', 'MEMBER_BINDING_REQUIRED');
});

test('Job cancellation or success cannot prove termination or external effects', () => {
  for (const conclusion of ['cancelled', 'success']) {
    check('interrupted', e => {
      e.jobConclusion = conclusion;
      e.writers[0].end = null;
      e.recovery.termination = 'unknown';
    }, 'unverified', 'PENDING_TERMINATION_OR_EFFECTS');
  }
  for (const key of ['termination', 'effects', 'authorization']) {
    check('interrupted', e => { e.recovery[key] = 'unknown'; }, 'unverified');
  }
  check('interrupted', e => { e.recovery.confirmedAt = 7; }, 'failed');
});

function addEarlierWriter(evidence, end) {
  evidence.writers[0].start = 2;
  evidence.writers.push({ ...evidence.writers[0],
    executionId: 'earlier-writer', start: 0, activeUntil: 1, end });
}

test('recovery requires termination of every earlier Writer', () => {
  for (const conclusion of ['cancelled', 'success']) {
    check('interrupted', e => {
      addEarlierWriter(e, null);
      e.jobConclusion = conclusion;
    }, 'unverified', 'PENDING_TERMINATION_OR_EFFECTS');
  }
  check('interrupted', e => {
    addEarlierWriter(e, null);
    e.writers.push({ ...e.writers.at(-1) });
  }, 'unverified', 'PENDING_TERMINATION_OR_EFFECTS');
  check('interrupted', e => { addEarlierWriter(e, 1); }, 'passed');
  check('interrupted', e => {
    addEarlierWriter(e, 5);
    Object.assign(e.writers.at(-1), { start: 4, activeUntil: 4 });
    e.recovery.confirmedAt = 4;
  }, 'failed', 'UNSAFE_REPLACEMENT');
});

test('Offline route and complete admissions cannot be replaced by Job status', () => {
  check('offline', e => { delete e.route; }, 'unverified');
  check('offline', e => { e.route.retainedMember++; }, 'failed');
  check('offline', e => {
    e.admissions = concurrencyFixture('duplicate').evidence.admissions;
    e.admissions[0].memberId++;
  }, 'failed', 'CROSS_MEMBER_ADMISSION');
});

function callerFixture(kind, edit = () => {}) {
  let next = 10;
  const counts = { triggers: 0, cleanups: 0, definitions: [], issues: [] };
  const caller = { mode: 'fixture',
    async createFixture(definition) {
      counts.definitions.push(definition);
      return { definition, lifecycle: {
        async setup() {
          const number = next++;
          counts.issues.push(number);
          return { state: 'passing', resources: [{ kind: 'issue', state: 'owned',
            native: { id: number + 100, number } }] };
        },
        async mutateIssue() { return { state: 'passing' }; },
        async teardown() { counts.cleanups++; return { state: 'passing' }; },
      } };
    },
    async trigger(binding) {
      counts.triggers++;
      return { wakeId: binding.wakeId, issue: binding.issue, status: 'completed' };
    },
    async readConcurrencyEvidence(binding) {
      const { evidence } = concurrencyFixture(kind, binding);
      edit(evidence);
      return evidence;
    },
    async observe(target) {
      const base = `https://api.github.com/repos/${target.repository}`;
      let data;
      if (target.kind === 'issue') data = { id: 100 + target.number,
        number: target.number, url: `${base}/issues/${target.number}` };
      if (target.kind === 'run') data = { id: target.runId,
        url: `${base}/actions/runs/${target.runId}`, run_attempt: target.attempt,
        repository: { full_name: target.repository } };
      if (target.kind === 'jobs') {
        const offset = target.runId - 20;
        data = [{ id: 30 + offset, url: `${base}/actions/jobs/${30 + offset}`,
          run_id: target.runId, run_attempt: target.attempt, runner_id: 40 + offset }];
      }
      return { complete: true, target, data };
    },
  };
  return { caller, counts };
}
const request = kind => ({ case: kind, repository: 'example/controlled', memberId: 7 });

for (const kind of cases) {
  test(`${kind}: bounded protected composition with synthetic capabilities`, async () => {
    const { caller, counts } = callerFixture(kind);
    const result = await runConcurrency(request(kind), caller);
    assert.equal(result.state, 'passed');
    assert.equal(result.liveVerified, false);
    assert.equal(result.mode, 'fixture');
    assert.equal(counts.cleanups, kind === 'independent' ? 2 : 1);
    assert.equal(counts.triggers, ['independent', 'duplicate'].includes(kind) ? 2 : 1);
    assert.equal(new Set(counts.definitions.map(d => d.owner)).size,
      counts.definitions.length);
  });
}

test('unknown trigger is not replayed; resources are retained', async () => {
  const { caller, counts } = callerFixture('duplicate');
  caller.trigger = async () => { counts.triggers++; throw new Error('secret'); };
  const result = await runConcurrency(request('duplicate'), caller);
  assert.equal(result.code, 'TRIGGER_EFFECT_UNKNOWN');
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(counts.triggers, 1);
  assert.equal(counts.cleanups, 0);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('missing capabilities and forged native identity remain unverified', async () => {
  assert.equal((await runConcurrency(request('duplicate'), { mode: 'live' })).code,
    'CAPABILITY_UNAVAILABLE');
  const { caller } = callerFixture('duplicate');
  caller.observe = async target => ({ complete: true, target, data: { id: 5 } });
  const result = await runConcurrency(request('duplicate'), caller);
  assert.equal(result.state, 'unverified');
  assert.equal(result.code, 'NATIVE_EXECUTION_UNAVAILABLE');
});

test('timeouts are bounded and cleanup preserves the original failure code', async () => {
  const { caller } = callerFixture('duplicate');
  caller.trigger = () => new Promise(() => {});
  const result = await runConcurrency(request('duplicate'), caller,
    { requestTimeoutMs: 10, timeoutMs: 100 });
  assert.equal(result.code, 'TRIGGER_EFFECT_UNKNOWN');
  assert.equal(result.cleanup, 'unresolved');
  const second = callerFixture('duplicate');
  second.caller.createFixture = async definition => ({ definition, lifecycle: {
    setup: async () => { throw new Error('private'); }, mutateIssue() {},
    teardown: async () => ({ state: 'blocked' }),
  } });
  const cleanup = await runConcurrency(request('duplicate'), second.caller);
  assert.equal(cleanup.code, 'FIXTURE_UNAVAILABLE');
  assert.equal(cleanup.cleanup, 'unresolved');
});

test('unknown history retains inventories and prepared sources', async () => {
  const { caller, counts } = callerFixture('interrupted', e => {
    e.writers[0].end = null;
    e.recovery.effects = 'unknown';
    e.effects = 'unknown';
  });
  let disposed = false;
  const result = await withDeliverySources(() =>
    runConcurrency(request('interrupted'), caller), async () => ({
    sources: {}, root: '/synthetic', dispose: async () => { disposed = true; },
  }));
  assert.equal(result.code, 'PENDING_TERMINATION_OR_EFFECTS');
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(result.sourceCleanup, 'deferred');
  assert.equal(counts.cleanups, 0);
  assert.equal(disposed, false);
});

test('earlier unresolved Writer preserves the recovery diagnostic and resources',
  async () => {
    const { caller, counts } = callerFixture('interrupted', e => {
      addEarlierWriter(e, null);
    });
    const result = await runConcurrency(request('interrupted'), caller);
    assert.equal(result.state, 'unverified');
    assert.equal(result.code, 'PENDING_TERMINATION_OR_EFFECTS');
    assert.equal(result.cleanup, 'unresolved');
    assert.equal(result.liveVerified, false);
    assert.equal(counts.cleanups, 0);
  });
