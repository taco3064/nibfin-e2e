import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryDefinition, repositorySeed } from '../repository-definition.mjs';
import { repositoryLifecycle } from '../repository-lifecycle.mjs';
import { repositoryGithub } from '../repository-github.mjs';
import { fixtureInventory } from '../fixture-inventory.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-repositories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = repositoryDefinition({ id: 7, login: 'test-user' },
    'test-user/control');
  const inventory = await fixtureInventory(join(root, 'inventory'), definition,
    7, join(root, 'worker'));
  const remote = new Map();
  const receipts = new Map();
  const calls = { creates: 0, seeds: 0 };
  const options = {};
  const context = { authorize: async () => true, idle: async () => true,
    receipt: async record => receipts.get(record.operation) };
  const provider = () => ({
    preflight: async () => 7,
    observe: async record => remote.get(record.repository) ?? null,
    createRepository: async record => {
      const state = JSON.parse(await readFile(inventory.path, 'utf8'));
      assert.equal(state.repositories.find(r => r.operation === record.operation)
        .creation, 'unresolved');
      calls.creates++;
      const native = { id: calls.creates, full_name: record.repository,
        owner: { id: 7, login: 'test-user', type: 'User' },
        description: definition.marker, default_branch: 'main',
        archived: false, disabled: false };
      remote.set(record.repository, native);
      receipts.set(record.operation, { operation: record.operation, native });
      if (options.creationLost) throw new Error('SECRET provider diagnostic');
      return native;
    },
    seedRepository: async record => {
      calls.seeds++;
      if (options.seedNoEffect) throw new Error('SECRET');
      remote.get(record.repository).seeded = true;
      if (options.seedLost) throw new Error('SECRET');
    },
    seedObserved: async record => remote.get(record.repository)?.seeded === true,
  });
  const lifecycle = () => repositoryLifecycle({ inventory, provider, context,
    bounds: options.bounds });
  return { definition, inventory, remote, receipts, calls, options, context,
    provider, lifecycle };
}

test('two durable repositories resume without replacement or writes', async t => {
  const f = await fixture(t);
  const first = await f.lifecycle().provision();
  assert.equal(first.state, 'ready');
  assert.equal(first.repositories.length, 2);
  assert.equal(new Set(first.repositories.map(r => r.native.id)).size, 2);
  assert.ok(first.repositories.every(r => r.seed === 'settled'));
  assert.deepEqual(await f.lifecycle().provision(), first);
  assert.deepEqual(f.calls, { creates: 2, seeds: 2 });
  assert.ok(!JSON.stringify(first).includes('SECRET'));
});

test('lost creation adopts exact protected receipt and current observation', async t => {
  const f = await fixture(t);
  f.options.creationLost = true;
  const partial = await f.lifecycle().provision();
  assert.equal(partial.state, 'unresolved');
  assert.equal(partial.repositories.length, 2);
  assert.equal(partial.repositories[1].creation, 'intended');
  f.options.creationLost = false;
  assert.equal((await f.lifecycle().provision()).state, 'ready');
  assert.equal(f.calls.creates, 2);
});

for (const fault of ['missing', 'wrong-intent', 'wrong-id', 'wrong-owner', 'marker']) {
  test(`unresolved creation rejects ${fault} evidence without writing`, async t => {
    const f = await fixture(t);
    f.options.creationLost = true;
    await f.lifecycle().provision();
    const [operation, receipt] = [...f.receipts][0];
    if (fault === 'missing') f.receipts.clear();
    if (fault === 'wrong-intent') receipt.operation = 'other';
    if (fault === 'wrong-id') {
      f.receipts.set(operation, structuredClone(receipt));
      receipt.native.id = 99;
    }
    if (fault === 'wrong-owner') receipt.native.owner.id = 99;
    if (fault === 'marker') receipt.native.description = 'changed';
    assert.equal((await f.lifecycle().provision()).state, 'unresolved');
    assert.deepEqual(f.calls, { creates: 1, seeds: 0 });
    assert.ok(!(await readFile(f.inventory.path, 'utf8')).includes('SECRET'));
  });
}

test('collision including a copied marker is never adopted', async t => {
  const f = await fixture(t);
  f.remote.set(f.definition.repositories[0], { description: f.definition.marker });
  assert.equal((await f.lifecycle().provision()).state, 'unresolved');
  assert.deepEqual(f.calls, { creates: 0, seeds: 0 });
});

for (const effect of [true, false]) {
  test(`uncertain seed reconciles observed effect=${effect} without replay`, async t => {
    const f = await fixture(t);
    f.options.seedLost = true;
    f.options.seedNoEffect = !effect;
    assert.equal((await f.lifecycle().provision()).state, 'unresolved');
    f.options.seedLost = false;
    f.options.seedNoEffect = false;
    const result = await f.lifecycle().provision();
    assert.equal(result.state, effect ? 'ready' : 'unresolved');
    assert.equal(f.calls.seeds, effect ? 2 : 1);
  });
}

test('settled identities and markers are rechecked before subsequent writes', async t => {
  const f = await fixture(t);
  await f.lifecycle().provision();
  f.remote.get(f.definition.repositories[0]).id = 99;
  assert.equal((await f.lifecycle().provision()).state, 'unresolved');
  assert.deepEqual(f.calls, { creates: 2, seeds: 2 });
});

test('authorization denial and production targets cause no writes', async t => {
  const f = await fixture(t);
  f.context.authorize = async () => false;
  assert.equal((await f.lifecycle().provision()).state, 'unresolved');
  const production = await fixture(t);
  production.definition.repositories[0] = 'production/project';
  assert.equal((await production.lifecycle().provision()).state, 'unresolved');
  assert.deepEqual(f.calls, { creates: 0, seeds: 0 });
  assert.deepEqual(production.calls, { creates: 0, seeds: 0 });
});

test('exclusive inventory prevents concurrent settlement', async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = f.inventory.exclusive(async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
  });
  await started;
  await assert.rejects(f.lifecycle().provision(), { code: 'EEXIST' });
  release();
  await held;
});

test('bounded timeout does not report readiness or leak diagnostics', async t => {
  const f = await fixture(t);
  const provider = () => ({ ...f.provider(),
    createRepository: () => new Promise(() => {}) });
  const result = await repositoryLifecycle({ inventory: f.inventory, provider,
    context: f.context, bounds: { requestTimeoutMs: 5 } }).provision();
  assert.equal(result.state, 'unresolved');
  assert.equal(result.repositories[0].creation, 'unresolved');
});

test('native seed uses deterministic tree and non-force branch update', async () => {
  const calls = [];
  const sha = 'a'.repeat(40);
  const record = { repository: 'test/repo', native: { defaultBranch: 'main' } };
  const adapter = repositoryGithub(async (method, url, body) => {
    calls.push({ method, url, body });
    return { data: { sha, object: { sha }, tree: { sha } } };
  });
  await adapter.seedRepository(record);
  assert.deepEqual(calls[2].body.tree.map(file => [file.path, file.content]),
    Object.entries(repositorySeed));
  assert.deepEqual(calls.at(-1).body, { sha, force: false });
  assert.ok(calls.at(-1).url.endsWith('/git/refs/heads/main'));
});

test('native seed observation rejects missing or altered content', async () => {
  const sha = 'a'.repeat(40);
  const record = { repository: 'test/repo', native: { defaultBranch: 'main' } };
  let altered = false;
  const adapter = repositoryGithub(async (method, url) => {
    if (url.includes('/git/ref/')) return { data: { object: { sha } } };
    const path = url.split('/contents/')[1].split('?')[0];
    return { data: { type: 'file', encoding: 'base64',
      content: Buffer.from(altered ? 'wrong' : repositorySeed[path])
        .toString('base64') } };
  });
  assert.equal(await adapter.seedObserved(record), true);
  altered = true;
  assert.equal(await adapter.seedObserved(record), false);
});

test('unconfirmed termination blocks recovery even with a matching receipt', async t => {
  const f = await fixture(t);
  f.options.creationLost = true;
  await f.lifecycle().provision();
  f.context.idle = async () => false;
  assert.equal((await f.lifecycle().provision()).state, 'unresolved');
  assert.deepEqual(f.calls, { creates: 1, seeds: 0 });
});

test('operation budget preserves partial pair and resumes the settled repository',
  async t => {
    const f = await fixture(t);
    f.options.bounds = { operations: 2 };
    const result = await f.lifecycle().provision();
    assert.equal(result.state, 'unresolved');
    assert.equal(result.repositories[0].seed, 'settled');
    assert.equal(result.repositories[1].creation, 'intended');
    f.options.bounds = undefined;
    assert.equal((await f.lifecycle().provision()).state, 'ready');
    assert.deepEqual(f.calls, { creates: 2, seeds: 2 });
  });

test('repository creation uses the validated User transport and sanitizes denial',
  async t => {
    const { fixtureGithub } = await import('../fixture-github.mjs');
    const { credentialConfiguration, credentialObservation } =
      await import('./credential-support.mjs');
    const f = await fixture(t);
    const calls = [];
    const provider = fixtureGithub({ ...credentialConfiguration('SECRET',
      f.definition.repository), fetcher: async (url, init) => {
      assert.equal(init.headers.authorization, 'Bearer SECRET');
      const observation = credentialObservation(url, f.definition.repository);
      if (observation) return observation;
      calls.push({ url, method: init.method, body: init.body });
      return { status: init.method === 'GET' ? 404 : 403,
        headers: { get: () => null }, json: async () => ({ message: 'SECRET' }) };
    } });
    const result = await repositoryLifecycle({ inventory: f.inventory, provider,
      context: f.context }).provision();
    assert.equal(result.state, 'unresolved');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[1].url, 'https://api.github.com/user/repos');
    const body = JSON.parse(calls[1].body);
    assert.equal(body.name, f.definition.repositories[0].split('/')[1]);
    assert.equal(body.description, f.definition.marker);
    assert.equal(body.private, true);
    assert.equal(body.auto_init, true);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.ok(!(await readFile(f.inventory.path, 'utf8')).includes('SECRET'));
  });

for (const field of ['owner', 'description', 'default_branch']) {
  test(`settled repository rejects changed ${field}`, async t => {
    const f = await fixture(t);
    await f.lifecycle().provision();
    const native = f.remote.get(f.definition.repositories[0]);
    native[field] = field === 'owner' ? { id: 99 } : 'changed';
    assert.equal((await f.lifecycle().provision()).state, 'unresolved');
    assert.deepEqual(f.calls, { creates: 2, seeds: 2 });
  });
}

test('seeded project runs its maintained test in a disposable directory', async t => {
  const { writeFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'nibfin-repository-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(repositorySeed)) {
    await writeFile(join(root, path), content);
  }
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
    cwd: root, env: {}, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pass 1/);
});

test('native incomplete observations cannot establish absence', async () => {
  const record = { repository: 'test/repo' };
  for (const response of [undefined, {}, { data: null }]) {
    await assert.rejects(repositoryGithub(async () => response).observe(record),
      /observation incomplete/);
  }
  assert.equal(await repositoryGithub(async () => null).observe(record), null);
});
