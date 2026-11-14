import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationFixture } from './publication-fixture.mjs';
import { createPublicationCoordinator } from '../publication-coordinator.mjs';

const ordered = ['core', 'action', 'cli'].flatMap(id =>
  ['tag', 'release', 'asset-asset'].map(operation => `${id}/${operation}`));

test('controlled publication verifies each operation in product order', async () => {
  const f = publicationFixture();
  const actual = await f.invoke();
  assert.equal(actual.outcome, 'published');
  assert.equal(actual.mode, 'contract-test');
  assert.deepEqual(actual.completed, ['core', 'action', 'cli']);
  assert.deepEqual(f.state.writes, ordered);
  assert.deepEqual(f.state.reads, ordered.flatMap(key => [key, key]));
  assert.equal(f.state.disposed, true);
  assert.doesNotMatch(JSON.stringify(f.state.record), /private|token|checkout/);
});

for (const product of ['action', 'cli']) {
  test(`failure in ${product} preserves prior products and resumes`, async () => {
    const f = publicationFixture();
    f.state.fail = `${product}/release`;
    const partial = await f.invoke();
    assert.equal(partial.outcome, 'blocked');
    assert.deepEqual(partial.completed, product === 'action' ? ['core'] :
      ['core', 'action']);
    assert.deepEqual(partial.unresolved, [product]);
    const writes = [...f.state.writes];
    assert.equal(writes.some(key => key.startsWith('cli/')), product === 'cli');
    f.state.fail = null;
    const resumed = await f.invoke({ resume: true });
    assert.equal(resumed.outcome, 'published');
    for (const key of writes.filter(key => key !== `${product}/release`)) {
      assert.equal(f.state.writes.filter(row => row === key).length, 1);
    }
    const count = f.state.writes.length;
    assert.equal((await f.invoke({ resume: true })).outcome, 'published');
    assert.equal(f.state.writes.length, count);
  });
}

test('lost response stops writes and reconciles without duplicates', async () => {
  const f = publicationFixture();
  f.state.ambiguous = true;
  assert.deepEqual((await f.invoke()).unresolved, ['core']);
  assert.deepEqual(f.state.writes, ['core/tag']);
  f.state.ambiguous = false;
  assert.equal((await f.invoke({ resume: true })).outcome, 'published');
  assert.equal(f.state.writes.filter(key => key === 'core/tag').length, 1);
});

test('unknown fresh observation prevents replay and dependent publication', async () => {
  const f = publicationFixture();
  f.state.ambiguous = true;
  await f.invoke();
  f.state.objects.set('core/tag', { state: 'unknown' });
  assert.deepEqual((await f.invoke({ resume: true })).unresolved, ['core']);
  assert.deepEqual(f.state.writes, ['core/tag']);
});

for (const state of ['matching', 'conflict']) {
  test(`preexisting ${state} tag cannot be adopted by name`, async () => {
    const f = publicationFixture();
    f.state.objects.set('core/tag', { state, object: { id: 'existing' } });
    assert.equal((await f.invoke()).outcome, 'blocked');
    assert.deepEqual(f.state.writes, []);
  });
}

test('write success without readback cannot complete a repository', async () => {
  const f = publicationFixture();
  f.state.absentAfterWrite = true;
  const actual = await f.invoke();
  assert.deepEqual(actual.completed, []);
  assert.deepEqual(actual.unresolved, ['core']);
  assert.deepEqual(f.state.writes, ['core/tag']);
});

for (const phase of ['authorization', 'conditions', 'coverage', 'e2e', 'preflight']) {
  test(`${phase} failure authorizes no publication`, async () => {
    const f = publicationFixture();
    if (phase === 'authorization') f.identity.authorized = false;
    if (phase === 'conditions') f.state.conditions = false;
    if (phase === 'coverage') f.dependencies.catalog[0].scenarioIds = [];
    if (phase === 'e2e') f.dependencies.run = async () => { throw Error('failed'); };
    if (phase === 'preflight') {
      const prepare = f.dependencies.prepare;
      f.dependencies.prepare = async () => ({ ...await prepare(),
        preflightRelease: async () => { throw Error('preflight failed'); } });
    }
    assert.equal((await f.invoke()).outcome, 'blocked');
    assert.deepEqual(f.state.writes, []);
  });
}

test('production rejects controlled and serialized handoffs', async () => {
  const f = publicationFixture();
  await f.invoke();
  const production = createPublicationCoordinator(f.capabilities);
  const count = f.state.writes.length;
  assert.equal((await production(['1.2.3'], { resume: true })).outcome, 'blocked');
  assert.equal((await production([f.state.record.plan.handoff])).outcome, 'blocked');
  assert.equal(f.state.writes.length, count);
});

test('resume requires consistent evidence and fresh authorization', async () => {
  for (const change of [
    f => { f.state.record = null; },
    f => { f.state.record.plan.handoff.sources[0].commit = 'b'.repeat(40); },
    f => { f.identity.authorized = false; },
    f => { f.state.conditions = false; },
  ]) {
    const f = publicationFixture();
    await f.invoke();
    const count = f.state.writes.length;
    change(f);
    assert.equal((await f.invoke({ resume: true })).outcome, 'blocked');
    assert.equal(f.state.writes.length, count);
  }
});

test('existing recovery requires resume; evidence precedes writes', async () => {
  const f = publicationFixture();
  await f.invoke();
  assert.equal((await f.invoke()).outcome, 'blocked');
  const fresh = publicationFixture();
  fresh.capabilities.evidence.save = async () => { throw Error('unavailable'); };
  assert.equal((await fresh.invoke()).outcome, 'blocked');
  assert.deepEqual(fresh.state.writes, []);
});


test('failed cleanup prevents publication after content capture', async () => {
  const f = publicationFixture();
  const prepare = f.dependencies.prepare;
  f.dependencies.prepare = async () => ({ ...await prepare(),
    dispose: async () => { throw Error('cleanup failed'); } });
  assert.equal((await f.invoke()).outcome, 'blocked');
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.state.record, null);
});

test('revoked conditions before a later write stop dependent publication', async () => {
  const f = publicationFixture();
  let checks = 0;
  f.capabilities.verifyConditions = async () => ++checks < 3;
  assert.equal((await f.invoke()).outcome, 'blocked');
  assert.deepEqual(f.state.writes, ['core/tag']);
});

test('malformed operation evidence blocks resume before writes', async () => {
  const f = publicationFixture();
  await f.invoke();
  f.state.record.operations['core/tag'] = { state: 'invented' };
  const count = f.state.writes.length;
  assert.equal((await f.invoke({ resume: true })).outcome, 'blocked');
  assert.equal(f.state.writes.length, count);
});
