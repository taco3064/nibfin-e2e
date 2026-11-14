import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixtureDefinition } from '../fixture-definition.mjs';
import { fixtureGithub } from '../fixture-github.mjs';
import { fixtureBudget } from '../fixture-budget.mjs';
import { githubObserver } from '../github-observer.mjs';
import { dependencyFixture } from './dependency-support.mjs';

const repository = 'fixture/repository';
const root = `https://api.github.com/repos/${repository}`;
const issue = number => ({ id: number + 100, number, url: `${root}/issues/${number}` });
async function pair(t) {
  const f = await dependencyFixture(t);
  const down = await f.caller.createFixture(
    fixtureDefinition('dependency-downstream', repository));
  const up = await f.caller.createFixture(
    fixtureDefinition('fresh-delivery', repository));
  await down.lifecycle.setup('issue');
  await up.lifecycle.setup('issue');
  return { ...f, down, up };
}
const saved = async owned => JSON.parse(await readFile(owned.inventory.path, 'utf8'));

test('authorization and exact owned identities precede dependency mutation', async t => {
  const f = await pair(t);
  f.context.authorize = async () => false;
  assert.equal((await f.down.lifecycle.addDependency(f.up.inventory)).reason,
    'FIXTURE_AUTHORIZATION_DENIED');
  assert.deepEqual(f.writes, []);
  f.context.authorize = async () => true;
  f.issues.get(29).id++;
  assert.equal((await f.down.lifecycle.addDependency(f.up.inventory)).reason,
    'FIXTURE_IDENTITY_MISMATCH');
  assert.deepEqual(f.writes, []);
  await assert.rejects(async () => f.down.lifecycle.addDependency(f.down.inventory),
    /DISTINCT_ISSUES/);
});

test('durable dependency intent prevents replay after a lost response', async t => {
  const f = await pair(t);
  const mutate = f.down.api.mutateIssue;
  let writes = 0;
  f.down.api.mutateIssue = async record => {
    writes++;
    const state = await saved(f.down);
    assert.equal(state.resources[0].mutation.operation, record.mutation.operation);
    await mutate(record);
    throw new Error('PRIVATE');
  };
  const result = await f.down.lifecycle.addDependency(f.up.inventory);
  assert.equal(result.state, 'unverified');
  assert.equal((await f.down.lifecycle.addDependency(f.up.inventory)).reason,
    'FIXTURE_RECONCILIATION_REQUIRED');
  assert.equal((await f.down.lifecycle.teardown()).reason,
    'FIXTURE_RECONCILIATION_REQUIRED');
  assert.equal(writes, 1);
  assert.equal((await f.down.lifecycle.reconcile()).state, 'passing');
  const record = (await saved(f.down)).resources[0];
  assert.deepEqual(record.dependency, { id: 10, number: 29 });
  assert.equal(record.mutation, undefined);
  assert.equal(writes, 1);
});

test('incomplete dependency read-back retains mutation until bounded reconciliation',
  async t => {
    const f = await pair(t);
    const dependencies = f.down.api.dependencies;
    f.down.api.dependencies = async () => [{ ...issue(29), url: 'foreign' }];
    assert.equal((await f.down.lifecycle.addDependency(f.up.inventory)).state,
      'unverified');
    assert.equal((await f.down.lifecycle.reconcile()).state, 'unverified');
    f.context.idle = async () => false;
    f.down.api.dependencies = dependencies;
    assert.equal((await f.down.lifecycle.reconcile()).reason, 'FIXTURE_USAGE_UNRESOLVED');
    f.context.idle = async () => true;
    assert.equal((await f.down.lifecycle.reconcile()).state, 'passing');
  });

test('native dependency write uses Issue ID, then independent paginated GET collection',
  async () => {
    const calls = [];
    const responses = [null, [issue(29)], [issue(31)]];
    const provider = fixtureGithub({ token: 'SYNTHETIC', fetcher: async (url, init) => {
      calls.push({ url, ...init });
      const index = calls.length - 1;
      return { status: index === 0 ? 201 : 200,
        headers: { get: () => index === 1 ? '<next>; rel="next"' : null },
        json: async () => responses[index] };
    } });
    const api = provider(fixtureBudget(), fixtureDefinition('native-edge', repository));
    const record = { native: { id: 130, number: 30 },
      mutation: { kind: 'add-blocked-by', upstream: { id: 129, number: 29 } } };
    await api.mutateIssue(record);
    assert.equal(calls[0].url, `${root}/issues/30/dependencies/blocked_by`);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body), { issue_id: 129 });
    assert.deepEqual(await api.dependencies(record), [issue(29), issue(31)]);
    assert.ok(calls[2].url.endsWith('per_page=100&page=2'));
  });

test('bounded native observations support bare dependency arrays in both directions',
  async () => {
    for (const kind of ['blocked_by', 'blocking']) {
      const target = { repository, kind, number: 30 };
      let requests = 0;
      const observe = githubObserver(async url => {
        requests++;
        assert.ok(url.includes(`/issues/30/dependencies/${kind}?`));
        return { status: 200, data: [issue(requests === 1 ? 29 : 31)],
          headers: requests === 1 ? { link: `<${url}&page=2>; rel="next"` } : {} };
      });
      const value = await observe(target);
      assert.equal(value.complete, true);
      assert.deepEqual(value.data, [issue(29), issue(31)]);
      assert.equal(requests, 2);
      const incomplete = githubObserver(async () => ({ status: 200,
        data: [issue(29)], headers: { link: `<${root}/wrong>; rel="next"` } }));
      assert.equal((await incomplete(target)).reason, 'invalid-pagination');
      const exhausted = githubObserver(async url => ({ status: 200,
        data: [issue(29)], headers: { link: `<${url}&page=2>; rel="next"` } }),
      { maxPages: 1 });
      assert.equal((await exhausted(target)).reason, 'page-budget-exhausted');
      const denied = githubObserver(async () => ({ status: 403 }));
      assert.equal((await denied(target)).reason, 'denied');
    }
  });
