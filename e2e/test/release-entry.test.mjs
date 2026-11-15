import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseEntry, releaseContractEntry } from '../release-entry.mjs';
import { publicationFixture } from './publication-fixture.mjs';
import { releaseObservations } from '../release-observations.mjs';
import { report, result } from '../schema.mjs';

const env = { NIBFIN_RELEASE_VERSION: '1.2.3' };
function fixture() {
  const f = publicationFixture();
  Object.assign(f.identity, {
    repository: 'taco3064/nibfin-e2e',
    workflow: '.github/workflows/nibfin-release.yml', environment: 'nibfin-release',
  });
  f.capabilities.observeActivePublications = async () => [];
  f.request = async url => ({ status: 200,
    data: url.pathname.endsWith('/git/ref/heads/main')
      ? { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } } : [] });
  f.invokeEntry = () => releaseContractEntry(env, f.request,
    f.capabilities, f.dependencies);
  return f;
}

test('entry routes one version through coordinator after cleanup', async () => {
  const f = fixture();
  const write = f.capabilities.native.write;
  f.capabilities.native.write = async context => {
    assert.equal(f.state.disposed, true);
    assert.equal(context.version, '1.2.3');
    return write(context);
  };
  const result = await f.invokeEntry();
  assert.equal(result.outcome, 'published');
  assert.equal(result.mode, 'contract-test');
  assert.equal(f.state.writes.length, 9);
});

test('production cannot select controlled dependencies or capabilities from data',
  async () => {
    const f = fixture();
    for (const input of [env, { ...env, NIBFIN_RELEASE_MODE: 'contract-test',
      NIBFIN_RELEASE_CAPABILITIES: JSON.stringify(f.capabilities) }]) {
      assert.equal((await releaseEntry(input, f.request)).outcome, 'blocked');
    }
    const incomplete = await releaseContractEntry(env, f.request, f.capabilities);
    assert.equal(incomplete.outcome, 'blocked');
    const result = await releaseEntry(env, f.request, f.capabilities);
    assert.equal(result.outcome, 'blocked');
    assert.match(result.reason, /NATIVE_COVERAGE: protected capabilities unavailable/);
    assert.equal(f.state.writes.length, 0);
  });

test('entry denies invalid versions, invocation and missing capabilities', async () => {
  for (const version of ['', 'v1.2.3', '1.2.3,2.0.0', '01.2.3']) {
    const f = fixture();
    const result = await releaseContractEntry({ NIBFIN_RELEASE_VERSION: version },
      f.request, f.capabilities, f.dependencies);
    assert.equal(result.outcome, 'blocked');
    assert.equal(f.state.writes.length, 0);
  }
  for (const key of ['native', 'evidence', 'verifyInvocation', 'verifyConditions',
    'observeActivePublications']) {
    const f = fixture();
    delete f.capabilities[key];
    assert.equal((await f.invokeEntry()).outcome, 'blocked');
    assert.equal(f.state.writes.length, 0);
  }
  const f = fixture();
  f.identity.authorized = false;
  assert.equal((await f.invokeEntry()).outcome, 'blocked');
  assert.equal(f.state.writes.length, 0);
});

test('entry denies conflicting aliases, drafts and unknown publication activity',
  async () => {
    for (const failure of ['tag', 'draft', 'activity', 'unavailable', 'partial']) {
      const f = fixture();
      const request = f.request;
      f.request = async url => {
        if (failure === 'unavailable') return { status: 403, data: null };
        if (failure === 'partial') return { status: 200, data: {} };
        if (failure === 'tag' && url.pathname.endsWith('/tags')) {
          return { status: 200, data: [{ name: '1.2.3' }] };
        }
        if (failure === 'draft' && url.pathname.endsWith('/releases')) {
          return { status: 200, data: [{ tag_name: 'v1.2.3', draft: true }] };
        }
        return request(url);
      };
      if (failure === 'activity') {
        f.capabilities.observeActivePublications = async () => undefined;
      }
      assert.equal((await f.invokeEntry()).outcome, 'blocked', failure);
      assert.equal(f.state.writes.length, 0);
    }
  });

test('conflict enumeration exhausts pages and includes drafts', async () => {
  const pages = [];
  const observations = releaseObservations(async url => {
    pages.push(url.searchParams.get('page'));
    const first = url.searchParams.get('page') === '1';
    return { status: 200, data: first ? Array.from({ length: 100 }, () =>
      ({ name: 'other', tag_name: 'other' })) :
      [{ name: 'v1.2.3', tag_name: '1.2.3', draft: true }] };
  }, async () => ['competing-run']);
  const rows = await observations.observeConflicts('1.2.3');
  assert.equal(pages.length, 12);
  assert.ok(rows.every(row => row.tags[0] === 'v1.2.3' &&
    row.releases[0] === '1.2.3' && row.activePublications[0] === 'competing-run'));
});

test('entry denies unavailable recovery evidence instead of starting fresh', async () => {
  for (const resume of [false, true]) {
    const f = fixture();
    f.capabilities.resume = resume;
    f.capabilities.evidence.load = async () => { throw new Error('expired'); };
    assert.equal((await f.invokeEntry()).outcome, 'blocked');
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.state.executions, 0);
  }
});

test('entry rechecks conditions before writes and stops on revocation', async () => {
  const f = fixture();
  const write = f.capabilities.native.write;
  f.capabilities.native.write = async context => {
    await write(context);
    f.state.conditions = false;
  };
  assert.equal((await f.invokeEntry()).outcome, 'blocked');
  assert.equal(f.state.writes.length, 1);
});

test('entry binds original invocation across recovery and preserves original content',
  async () => {
    const f = fixture();
    f.state.fail = 'action/tag';
    assert.equal((await f.invokeEntry()).outcome, 'blocked');
    const original = structuredClone(f.state.record.plan);
    f.capabilities.resume = true;
    f.state.fail = null;
    f.dependencies.prepare = () => assert.fail('recovery reacquired sources');
    // Protected conditions reconcile owned partial objects. The entry does not
    // run fresh conflict checks that would misclassify this run's own tags.
    f.request = () => assert.fail('recovery observed newer main or fresh conflicts');
    assert.equal((await f.invokeEntry()).outcome, 'published');
    assert.deepEqual(f.state.record.plan, original);
    const count = f.state.writes.length;
    f.identity.runId = 'different';
    assert.equal((await f.invokeEntry()).outcome, 'blocked');
    assert.equal(f.state.writes.length, count);
  });


test('entry prevents writes on stale sources, cleanup and mandatory E2E failures',
  async () => {
    for (const failure of ['stale', 'substituted', 'cleanup', 'failed', 'blocked',
      'unverified', 'missing']) {
      const f = fixture();
      if (failure === 'stale') {
        const request = f.request;
        f.request = async url => url.pathname.endsWith('/git/ref/heads/main')
          ? { status: 200, data: { ref: 'refs/heads/main',
            object: { sha: 'b'.repeat(40) } } } : request(url);
      } else if (failure === 'cleanup') {
        const prepare = f.dependencies.prepare;
        f.dependencies.prepare = async () => ({ ...await prepare(),
          dispose: async () => { throw new Error('cleanup unavailable'); } });
      } else {
        f.dependencies.run = async selected => {
          if (failure === 'substituted') {
            const prepared = await f.dependencies.prepare();
            prepared.sources.core.commit = 'b'.repeat(40);
          }
          return report(failure === 'missing' ? [] : selected.map(row =>
            result(row, failure === 'substituted' ? 'passed' : failure,
              'CONTROLLED', 'controlled denial')));
        };
      }
      assert.equal((await f.invokeEntry()).outcome, 'blocked', failure);
      assert.equal(f.state.writes.length, 0);
    }
  });

test('recovery rejects corrupt evidence and preserves unknown effects', async () => {
  const f = fixture();
  f.state.ambiguous = true;
  assert.equal((await f.invokeEntry()).outcome, 'blocked');
  assert.equal(f.state.writes.length, 1);
  f.capabilities.resume = true;
  f.capabilities.native.observe = async () => ({ state: 'unknown' });
  assert.equal((await f.invokeEntry()).outcome, 'blocked');
  assert.equal(f.state.writes.length, 1);
  f.state.record.identity = 'corrupt';
  assert.equal((await f.invokeEntry()).outcome, 'blocked');
  assert.equal(f.state.writes.length, 1);
});
