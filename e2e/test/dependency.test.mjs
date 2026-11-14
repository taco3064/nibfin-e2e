import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runDependency } from '../dependency-protected.mjs';
import { reconcileDependencyExecution } from '../dependency-recovery.mjs';
import { dependencyFixture } from './dependency-support.mjs';

const request = { repository: 'fixture/repository', path: 'answer.txt', content: '42\n' };
const ledger = async owned => JSON.parse(await readFile(owned.inventory.path, 'utf8'));

test('owned pair proves blocked admission, delivery and actual downstream invocation',
  async t => {
    const f = await dependencyFixture(t);
    const result = await runDependency(request, f.caller);
    assert.equal(result.state, 'passed', JSON.stringify(result));
    assert.equal(result.mode, 'fixture');
    assert.equal(result.liveVerified, false);
    assert.deepEqual(f.admissions.map(value => value.phase), ['before', 'after']);
    assert.equal(f.owned.length, 2);
    assert.notEqual(f.owned[0].definition.owner, f.owned[1].definition.owner);
    assert.equal(f.admissions[1].continuation.runId, 200);
    assert.deepEqual(f.writes, ['edit-issue-body', 'edit-issue-body',
      'add-blocked-by', 'close-30']);
    assert.equal((await ledger(f.owned[0])).dependencyExecution.state, 'observed');
  });

test('capability and request failures have no writes', async t => {
  const f = await dependencyFixture(t);
  for (const name of ['admitDependency', 'readDependencyEvidence', 'observe']) {
    const caller = { ...f.caller };
    delete caller[name];
    const result = await runDependency(request, caller);
    assert.equal(result.state, 'blocked');
    assert.equal(result.capability, name);
  }
  assert.equal((await runDependency({ ...request, path: '../escape' }, f.caller)).state,
    'blocked');
  assert.deepEqual(f.writes, []);
});

for (const defect of ['missing-edge', 'wrong-issue', 'closed-upstream',
  'incomplete-edge', 'reverse-edge', 'duplicate-edge', 'foreign-edge']) {
  test(`native pair refuses ${defect} before admission`, async t => {
    const f = await dependencyFixture(t);
    const observe = f.caller.observe;
    f.caller.observe = async target => {
      const o = await observe(target);
      if (target.kind === 'blocked_by') {
        if (defect === 'missing-edge') o.data = [];
        if (defect === 'wrong-issue') o.data[0].id++;
        if (defect === 'incomplete-edge') o.complete = false;
        if (defect === 'duplicate-edge') o.data.push(o.data[0]);
        if (defect === 'foreign-edge') o.data[0].url = 'https://example.com/issues/29';
      }
      if (defect === 'reverse-edge' && target.kind === 'blocking') o.data = [];
      if (defect === 'closed-upstream' && target.kind === 'issue' &&
          target.number === 29) o.data.state = 'closed';
      return o;
    };
    const result = await runDependency(request, f.caller);
    assert.equal(result.state, 'unverified');
    assert.equal(f.admissions.length, 0);
  });
}

const admissionDefects = {
  'silent scheduling': e => { e.admission = { status: 'scheduled', results: [] }; },
  'copied request': e => { e.admission.requestId = 'previous'; },
  'wrong downstream': e => { e.admission.issue++; },
  'wrong upstream': e => { e.admission.upstreamIssue++; },
  'wrong delivery': e => { e.admission.upstreamRequestId = 'previous'; },
  'no authorization': e => { e.admission.authorized = false; },
  'no invocation': e => { e.admission.executed = false; },
  'no job': e => { delete e.admission.jobId; },
};
for (const [name, mutate] of Object.entries(admissionDefects)) {
  test(`blocked observation rejects ${name} and retains intent`, async t => {
    const f = await dependencyFixture(t);
    const read = f.caller.readDependencyEvidence;
    f.caller.readDependencyEvidence = async binding => {
      const evidence = await read(binding);
      mutate(evidence);
      return evidence;
    };
    const result = await runDependency(request, f.caller);
    assert.equal(result.state, 'unverified');
    assert.equal(result.cleanup, 'unresolved');
    assert.equal(f.admissions.length, 1);
    assert.equal((await ledger(f.owned[0])).dependencyExecution.state, 'intent');
    assert.equal(f.writes.includes('close-30'), false);
  });
}

for (const decision of ['eligible', 'blocked', 'ineligible']) {
  test(`post-completion ${decision} is explicit and never dispatch success`, async t => {
    const f = await dependencyFixture(t);
    const admit = f.caller.admitDependency;
    const read = f.caller.readDependencyEvidence;
    f.caller.admitDependency = async binding => {
      const expected = await admit(binding);
      if (binding.phase === 'after') {
        expected.decision = decision;
        const native = f.nativeExecutions.get(expected.runId);
        native.run.status = 'completed';
        native.run.conclusion = 'success';
        native.jobs[0].status = 'completed';
        native.jobs[0].conclusion = 'success';
      }
      return expected;
    };
    f.caller.readDependencyEvidence = async binding => {
      const evidence = await read(binding);
      if (binding.phase === 'after') evidence.admission.decision = decision;
      return evidence;
    };
    const result = await runDependency(request, f.caller);
    assert.equal(result.state, 'unverified');
    assert.equal(result.downstream.decision, decision);
    assert.equal(result.cleanup, decision === 'eligible' ? 'unresolved' : undefined);
  });
}

for (const defect of ['wrong-origin', 'copied-upstream', 'wrong-attempt',
  'unrelated-job', 'queued-run', 'not-dispatch', 'missing-native']) {
  test(`downstream rejects ${defect}`, async t => {
    const f = await dependencyFixture(t);
    const read = f.caller.readDependencyEvidence;
    f.caller.readDependencyEvidence = async binding => {
      const e = await read(binding);
      if (binding.phase === 'after') {
        if (defect === 'wrong-origin') e.admission.continuation.runId++;
        if (defect === 'copied-upstream') Object.assign(e.admission,
          binding.continuation);
      }
      return e;
    };
    const observe = f.caller.observe;
    f.caller.observe = async target => {
      const o = await observe(target);
      if (target.runId === 502) {
        if (defect === 'missing-native') o.complete = false;
        if (target.kind === 'run') {
          if (defect === 'wrong-attempt') o.data.run_attempt++;
          if (defect === 'queued-run') o.data.status = 'queued';
          if (defect === 'not-dispatch') o.data.event = 'issues';
        }
        if (target.kind === 'jobs' && defect === 'unrelated-job') o.data[0].id++;
      }
      return o;
    };
    const result = await runDependency(request, f.caller);
    assert.equal(result.state, 'unverified');
    assert.equal(result.cleanup, 'unresolved');
    assert.equal(f.admissions.length, 2);
  });
}

test('lost dispatch response is not replayed; independent read-back recovers intent',
  async t => {
    const f = await dependencyFixture(t);
    const admit = f.caller.admitDependency;
    f.caller.admitDependency = async binding => {
      const result = await admit(binding);
      if (binding.phase === 'after') throw new Error('PRIVATE');
      return result;
    };
    const result = await runDependency(request, f.caller);
    assert.equal(result.cleanup, 'unresolved');
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    const downstream = f.owned[0];
    assert.equal((await ledger(downstream)).dependencyExecution.state, 'intent');
    assert.equal((await downstream.lifecycle.teardown()).state, 'unverified');
    assert.equal((await reconcileDependencyExecution(downstream.inventory,
      f.caller)).state, 'passing');
    assert.equal(f.admissions.length, 2);
    f.context.idle = async () => false;
    assert.equal((await downstream.lifecycle.teardown()).state, 'unverified');
    f.context.idle = async () => true;
    assert.equal((await downstream.lifecycle.teardown()).state, 'passing');
  });

test('upstream cleanup closure cannot replace eligible delivery', async t => {
  const f = await dependencyFixture(t);
  f.caller.readDeliveryEvidence = async () => { throw new Error('unavailable'); };
  const result = await runDependency(request, f.caller);
  assert.equal(result.state, 'unverified');
  assert.equal(f.admissions.length, 1);
  assert.equal(f.issues.get(29).state, 'closed');
  assert.deepEqual(f.issues.get(29).labels, []);
});

test('ordinary execution exposes the missing protected capability', async () => {
  const { execute } = await import('../execution.mjs');
  const { scenarios } = await import('../registry.mjs');
  const result = await execute(scenarios.find(item => item.id === 'dependency.live'));
  assert.equal(result.outcome, 'blocked');
  assert.match(result.reason.message, /Protected dependency caller.*continuation/);
});

test('upstream unresolved cleanup propagates source retention despite idle downstream',
  async t => {
    const f = await dependencyFixture(t);
    const create = f.caller.createFixture;
    f.caller.createFixture = async definition => {
      const owned = await create(definition);
      if (definition.scenario === 'fresh-delivery') {
        owned.lifecycle.teardown = async () => ({ state: 'unverified' });
      }
      return owned;
    };
    const { withDeliverySources } = await import('../delivery-sources.mjs');
    let disposed = false;
    const result = await withDeliverySources(() => runDependency(request, f.caller),
      async () => ({ dispose: async () => { disposed = true; } }));
    assert.equal(result.cleanup, 'unresolved');
    assert.equal(result.sourceCleanup, 'deferred');
    assert.equal(disposed, false);
    assert.equal(f.admissions.length, 1);
  });

test('stalled observation preserves unknown-effect recovery state', async t => {
  const f = await dependencyFixture(t);
  f.caller.readDependencyEvidence = () => new Promise(() => {});
  const result = await runDependency(request, f.caller,
    { requestTimeoutMs: 100, timeoutMs: 2000 });
  assert.equal(result.state, 'unverified');
  assert.equal(result.cleanup, 'unresolved');
  assert.equal(f.admissions.length, 1);
  assert.equal((await ledger(f.owned[0])).dependencyExecution.state, 'intent');
  assert.equal((await reconcileDependencyExecution(f.owned[0].inventory,
    f.caller, { requestTimeoutMs: 10 })).state, 'unverified');
});

test('post-delivery dependency read-back is mandatory before continuation', async t => {
  const f = await dependencyFixture(t);
  const read = f.caller.readDeliveryEvidence;
  f.caller.readDeliveryEvidence = async binding => {
    const evidence = await read(binding);
    f.setEdge(false);
    return evidence;
  };
  const result = await runDependency(request, f.caller);
  assert.equal(result.code, 'COMPLETED_DEPENDENCY_READ_UNVERIFIED');
  assert.equal(f.admissions.length, 1);
});

test('live dependency requests cannot target another repository', async t => {
  const f = await dependencyFixture(t);
  f.caller.mode = 'live';
  const result = await runDependency(request, f.caller);
  assert.equal(result.state, 'blocked');
  assert.equal(result.code, 'INVALID_REQUEST');
  assert.equal(f.owned.length, 0);
});

test('ineligible fanout reports a reason without a downstream Run', async t => {
  const f = await dependencyFixture(t);
  const admit = f.caller.admitDependency;
  const read = f.caller.readDependencyEvidence;
  const ineligible = (value, binding) => binding.phase === 'after' ? {
    ...value, ...binding.continuation, ...binding,
    decision: 'ineligible', reason: 'NO_ELIGIBLE_ASSIGNEE',
  } : value;
  f.caller.admitDependency = async binding => ineligible(await admit(binding), binding);
  f.caller.readDependencyEvidence = async binding => {
    const e = await read(binding);
    e.admission = ineligible(e.admission, binding);
    return e;
  };
  const result = await runDependency(request, f.caller);
  assert.equal(result.state, 'unverified');
  assert.equal(result.cleanup, undefined);
  assert.deepEqual(result.downstream,
    { decision: 'ineligible', reason: 'NO_ELIGIBLE_ASSIGNEE' });
});
