import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCoverageFixture } from './release-coverage-support.mjs';

for (const change of [
  f => { delete f.capabilities.suite; },
  f => { f.suite.provenance = 'controlled'; },
  f => { f.suite.binding = 'other/invocation/1'; },
  f => { f.suite.sources[0].commit = 'f'.repeat(40); },
  f => { f.suite.sourceOwner = 'another-owner'; },
  f => { f.suite.phases.delivery.state = 'unobserved'; },
  f => { f.suite.cleanup = 'pending'; },
  f => { f.suite.pending.push('native-run/unknown'); },
  f => { f.suite.outcome = 'non-passing'; },
  f => { f.capabilities.suite.open = async () => ({ prepared: f.prepared }); },
]) {
  test('suite gate rejects unavailable, controlled, stale or incomplete evidence',
    async t => {
      const f = await releaseCoverageFixture(t);
      change(f);
      const result = await f.invoke();
      assert.equal(result.outcome, 'blocked');
      assert.match(result.reason, /SUITE/);
      assert.equal(f.release, null);
      assert.equal(f.state.staged, 0);
      assert.equal(f.state.writes, 0);
      assert.equal(f.state.disposed, 0);
      assert.equal(f.prepared.disposed, false);
    });
}

test('suite owner is consumed without reacquiring current main sources', async t => {
  const f = await releaseCoverageFixture(t);
  f.dependencies.prepare = () => assert.fail('must retain original suite owner');
  const result = await f.invoke();
  assert.equal(result.outcome, 'ready');
  assert.equal(result.handoff.mode, 'contract-test');
  assert.equal(f.state.prepared, 1);
  assert.equal(f.state.disposed, 1);
});
