import test from 'node:test';
import assert from 'node:assert/strict';
import { enrollmentFixture } from './peer-fixture.mjs';

const enrolled = result => result.disposition === 'success';

test('peer adoption consumes installation, exact templates and complete empty B',
  async t => {
    const f = await enrollmentFixture(t);
    const result = await f.peer().enroll();
    assert(enrolled(result));
    assert.equal(result.origin, 'synthetic');
    assert.deepEqual(result.runners.map(r => r.id), [41, 42]);
    assert.equal(result.targetRunnerCount, 0);
    assert.equal(result.binding.repositoryId, 8);
    assert.equal(result.binding.runRepositoryId, 7);
    assert(enrolled(await f.peer().enroll()));
    assert.equal(f.adoptions(), 1);
    assert.deepEqual((await f.read()).installation.runners.map(r => r.id), [41, 42]);
    assert(!JSON.stringify(result).includes('content'));
  });

const invalid = {
  'unknown adoption': r => { delete r.adopted; },
  'target ID': r => { r.binding.repositoryId++; },
  'target name': r => { r.binding.repository = 'other/repository'; },
  'member': r => { r.authenticatedMemberId++; },
  'source': r => { r.sources.core.commit = 'f'.repeat(40); },
  'incomplete B': r => { r.registrations.complete = false; },
  'missing B': r => { delete r.registrations.runners; },
  'nonempty B': r => { r.registrations.runners.push({ id: 99 }); },
  'wrong B read': r => { r.registrations.repositoryId = 7; },
  'incomplete A': r => { r.executionRegistrationsComplete = false; },
  'replacement': r => { r.executionRunners[1].id = 99; },
  'duplicate': r => { r.executionRunners[1] = r.executionRunners[0]; },
  'caller substitution': r => { r.callers.issue.content = 'other'; },
  'Action substitution': r => { r.callers.action.blob = 'f'.repeat(40); },
  'execution substitution': r => { r.callers.execution.content = 'other'; },
  'stale caller ref': r => { r.callers.issue.ref = 'stale'; },
  'incomplete caller': r => { r.callers.issue.complete = false; },
};
for (const [name, mutate] of Object.entries(invalid)) {
  test(`peer refuses ${name} without enrollment effects`, async t => {
    const f = await enrollmentFixture(t);
    // Keep prepared producer inputs independent from the observed source read.
    f.raw.sources = structuredClone(f.raw.sources);
    mutate(f.raw);
    assert(!enrolled(await f.peer().enroll()));
    assert.equal(f.adoptions(), 0);
  });
}

test('peer requires upstream installation and authorization', async t => {
  const f = await enrollmentFixture(t);
  f.peerContext.authorize = async () => false;
  assert.equal((await f.peer().enroll()).code, 'PEER_PERMISSION_UNAVAILABLE');
  assert.equal(f.adoptions(), 0);
  await f.change(state => { state.installation.pending = { operation: 'init' }; });
  f.peerContext.authorize = async () => true;
  assert(!enrolled(await f.peer().enroll()));
  assert.equal(f.adoptions(), 0);
});

test('lost enrollment response preserves intent and blocks replay until reconciled',
  async t => {
    const f = await enrollmentFixture(t);
    let writes = 0;
    f.peerContext.adopt = async () => {
      writes++;
      f.raw.adopted = true;
      throw new Error('secret provider error');
    };
    f.peerContext.reconcile = async () => ({ terminated: false,
      effects: 'reconciled' });
    const first = await f.peer().enroll();
    assert(first.recoveryPending);
    assert(!JSON.stringify(first).includes('secret'));
    assert(!enrolled(await f.peer().enroll()));
    assert.equal(writes, 1);
    f.peerContext.reconcile = async () => ({ terminated: true, effects: 'unknown' });
    assert(!enrolled(await f.peer().enroll()));
    assert.equal(writes, 1);
    f.peerContext.reconcile = async () => ({ terminated: true,
      effects: 'reconciled' });
    const final = await f.peer().enroll();
    assert(enrolled(final));
    assert.equal(final.recoveryPending, false);
    assert.equal(writes, 1);
  });

test('enrollment timeout cancels protected operation and leaves recovery intent',
  async t => {
    const f = await enrollmentFixture(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requestTimeoutMs = 5000;
    let signal;
    let adoptions = 0;
    f.peerContext.adopt = async (_, options) => {
      adoptions++;
      signal = options.signal;
      assert.equal(signal.aborted, false);
      // Expire only after adoption starts, independent of prerequisite I/O time.
      t.mock.timers.tick(requestTimeoutMs);
      return new Promise(() => {});
    };
    const first = await f.peer({ requestTimeoutMs }).enroll();
    assert.equal(adoptions, 1);
    assert.equal(signal.aborted, true);
    assert(first.recoveryPending);
    f.peerContext.reconcile = async () => ({ terminated: false, effects: 'unknown' });
    assert(!enrolled(await f.peer().enroll()));
    assert.equal((await f.read()).installation.peers[8].pending.sequence, 1);
    assert.equal(adoptions, 1);
  });

test('read budgets and changed enrollment prevent adoption replay', async t => {
  const f = await enrollmentFixture(t);
  assert(!enrolled(await f.peer({ requests: 2 }).enroll()));
  assert.equal(f.adoptions(), 0);
  assert(enrolled(await f.peer().enroll()));
  f.raw.adopted = false;
  assert(!enrolled(await f.peer().enroll()));
  assert.equal(f.adoptions(), 1);
});
