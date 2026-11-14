import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureGithub } from '../fixture-github.mjs';
import { fixtureBudget } from '../fixture-budget.mjs';
import { fixtureDefinition } from '../fixture-definition.mjs';
import { fixture, sha } from './fixture-support.mjs';
import { fixtureLifecycle } from '../fixture-lifecycle.mjs';

const response = (data, status = 200, link = null) => ({
  status, headers: { get: () => link }, json: async () => data,
});
function adapter(responses, definition = fixtureDefinition('native-adapter')) {
  const calls = [];
  const provider = fixtureGithub({ token: 'PRIVATE', fetcher: async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer PRIVATE');
    if (!responses.length) throw new Error('Unexpected request');
    return responses.shift();
  } });
  return { api: provider(fixtureBudget(), definition), calls, definition };
}

test('native preflight observes the authenticated actor and exact target', async () => {
  const definition = fixtureDefinition('native-adapter');
  const repo = { full_name: definition.repository, archived: false, disabled: false };
  const f = adapter([response({ id: 7 }), response(repo)], definition);
  assert.equal(await f.api.preflight(), 7);
  assert.equal(f.calls[0].url, 'https://api.github.com/user');
  assert.equal(f.calls[1].url,
    `https://api.github.com/repos/${definition.repository}`);
  for (const data of [{ ...repo, full_name: 'other/repo' },
    { ...repo, archived: true }, { full_name: definition.repository }]) {
    await assert.rejects(adapter([response({ id: 7 }), response(data)], definition)
      .api.preflight());
  }
});

test('native branch setup requires absence and matching base commit', async () => {
  const record = { kind: 'branch', payload: { sha } };
  const f = adapter([response(null, 404), response({ sha })]);
  await f.api.beforeCreate(record);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  await assert.rejects(adapter([response({ ref: 'existing' })]).api.beforeCreate(record));
  await assert.rejects(adapter([response(null, 403)]).api.beforeCreate(record));
  await assert.rejects(adapter([response(null, 404), response({ sha: 'wrong' })])
    .api.beforeCreate(record));
});

test('native PR setup rejects maintained files, escaped renames and truncation',
  async () => {
    const definition = fixtureDefinition('generated-surface');
    const record = { kind: 'pull', payload: { base: 'main' } };
    const branch = response({ ref: `refs/heads/${definition.name}` });
    const file = { filename: definition.generatedRoot + 'example.mjs' };
    for (const data of [
      { files: [{ filename: 'e2e/runner.mjs' }], total_commits: 1 },
      { files: [{ ...file, previous_filename: '.github/workflows/ci.yml' }],
        total_commits: 1 },
      { files: Array(300).fill(file), total_commits: 1 },
      { files: [file], total_commits: 101 }, { total_commits: 1 },
    ]) {
      await assert.rejects(adapter([branch, response(data)], definition)
        .api.beforeCreate(record));
    }
    const f = adapter([branch, response({ files: [file], total_commits: 1 })],
      definition);
    await f.api.beforeCreate(record);
    assert.ok(f.calls[1].url.includes('/compare/main...nibfin-fixture%2F'));
  });

test('branch retention observes all PR pages and refuses incomplete merge observations',
  async () => {
    const definition = fixtureDefinition('merged-history');
    const branch = { ref: `refs/heads/${definition.name}`, object: { sha } };
    const pull = { head: { ref: definition.name,
      repo: { full_name: definition.repository } }, merged_at: '2026-11-14T00:00:00Z' };
    const f = adapter([response(branch), response([], 200, '<next>; rel="next"'),
      response([pull])], definition);
    assert.equal((await f.api.read({ kind: 'branch' })).merged, true);
    assert.equal(f.calls.length, 3);
    for (const pulls of [[], [{ ...pull, merged_at: null }],
      [{ head: { ...pull.head, ref: 'unrelated' } }]]) {
      const unmerged = adapter([response(branch), response(pulls)], definition);
      assert.equal((await unmerged.api.read({ kind: 'branch' })).merged, false);
    }
    delete pull.merged_at;
    await assert.rejects(adapter([response(branch), response([pull])], definition)
      .api.read({ kind: 'branch' }));
  });

test('native create and cleanup have only narrow supported write paths', async () => {
  const f = adapter([response({ id: 1 }), response({}), response(null, 204)]);
  await f.api.create({ kind: 'issue', payload: { title: 'fixture' } });
  await f.api.cleanup({ kind: 'pull', native: { number: 5 } });
  await f.api.cleanup({ kind: 'branch' });
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'PATCH', 'DELETE']);
  assert.ok(f.calls[0].url.endsWith('/issues'));
  assert.ok(f.calls[1].url.endsWith('/pulls/5'));
  assert.deepEqual(JSON.parse(f.calls[1].body), { state: 'closed' });
  assert.ok(f.calls[2].url.endsWith(`/git/refs/heads/${f.definition.name}`));
});

test('native adapter lifecycle covers fresh reads and bounded writes',
  async t => {
    const f = await fixture(t);
    const calls = [];
    let issue;
    const provider = fixtureGithub({ token: 'SYNTHETIC', fetcher: async (url, init) => {
      calls.push([url, init.method]);
      if (url.endsWith('/user')) return response({ id: 7 });
      const root = `https://api.github.com/repos/${f.definition.repository}`;
      if (url === root) return response({ full_name: f.definition.repository,
        archived: false, disabled: false });
      if (init.method === 'POST') {
        issue = { ...JSON.parse(init.body), id: 100, number: 10,
          user: { id: 7 }, state: 'open', url: `${root}/issues/10` };
        return response(issue, 201);
      }
      if (init.method === 'PATCH') issue.state = 'closed';
      return response(structuredClone(issue));
    } });
    const lifecycle = fixtureLifecycle({ inventory: f.inventory, provider,
      context: f.context });
    assert.equal((await lifecycle.setup('issue')).state, 'passing');
    assert.equal((await lifecycle.teardown()).state, 'passing');
    assert.deepEqual(calls.map(([, method]) => method),
      ['GET', 'GET', 'POST', 'GET', 'GET', 'GET', 'GET', 'PATCH', 'GET']);
  });

test('native adapter timeout includes stalled response body consumption', async () => {
  const provider = fixtureGithub({ token: 'SYNTHETIC', fetcher: async () => ({
    status: 200, headers: { get: () => null }, json: () => new Promise(() => {}),
  }) });
  const api = provider(fixtureBudget({ requestTimeoutMs: 5 }),
    fixtureDefinition('stalled-body'));
  await assert.rejects(api.preflight(), /unavailable/);
});


test('incomplete PR observations block lifecycle branch deletion until resolved',
  async t => {
    const f = await fixture(t);
    assert.equal((await f.lifecycle().setup('branch', { sha })).state, 'passing');
    const branch = f.resources.get(f.definition.name);
    const head = { ref: f.definition.name,
      repo: { full_name: f.definition.repository } };
    let pulls;
    const writes = [];
    const provider = fixtureGithub({ token: 'SYNTHETIC', fetcher: async (url, init) => {
      if (init.method !== 'GET') {
        writes.push(init.method);
        return response(null, 204);
      }
      if (url.endsWith('/user')) return response({ id: 7 });
      if (url.includes('/pulls?')) return response(pulls);
      if (url.includes('/git/ref/')) return response(branch);
      return response({ full_name: f.definition.repository,
        archived: false, disabled: false });
    } });
    const lifecycle = fixtureLifecycle({ inventory: f.inventory, provider,
      context: f.context });
    const incomplete = [null, {}, { head: {} }, { head: { ref: head.ref } },
      { head: { repo: head.repo } }, { head: { ...head, repo: null } },
      { head: { ...head, ref: '' } },
      { head: { ...head, repo: { full_name: '' } } },
      ...[undefined, false, 0, '', 'invalid', {}].map(merged_at =>
        ({ head, merged_at }))];
    for (const pull of incomplete) {
      pulls = [pull];
      const result = await lifecycle.teardown();
      assert.equal(result.state, 'unverified', JSON.stringify(pull));
      assert.equal(result.resources[0].state, 'owned');
      assert.deepEqual(writes, []);
    }
    pulls = [{ head, merged_at: '2026-11-14T00:00:00Z' }];
    const retained = await lifecycle.teardown();
    assert.equal(retained.state, 'passing');
    assert.equal(retained.resources[0].disposition, 'merged-history');
    assert.deepEqual(writes, []);
  });
