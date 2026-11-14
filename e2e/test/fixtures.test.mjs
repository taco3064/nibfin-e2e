import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, sha } from './fixture-support.mjs';
import { defaultTarget, generatedPath } from '../fixture-definition.mjs';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { fixtureBudget } from '../fixture-budget.mjs';

const records = async f => JSON.parse(await readFile(f.inventory.path, 'utf8'));
const change = async (f, mutate) => {
  const state = await records(f);
  mutate(state);
  await writeFile(f.inventory.path, JSON.stringify(state));
};
async function setupAll(f) {
  for (const [kind, input] of [['issue'], ['branch', { sha }],
    ['pull', { base: 'main' }]]) {
    assert.equal((await f.lifecycle().setup(kind, input)).state, 'passing');
  }
}

test('default fixture surface excludes framework, tests, workflows and traversal', t => {
  return fixture(t).then(f => {
    assert.equal(f.definition.repository, defaultTarget);
    assert.equal(generatedPath(f.definition,
      f.definition.generatedRoot + 'demo.mjs'), true);
    for (const path of ['e2e/runner.mjs', 'e2e/test/a.mjs', '.github/workflows/ci.yml',
      f.definition.generatedRoot + '../escape',
      f.definition.generatedRoot + 'a\\b', f.definition.generatedRoot]) {
      assert.equal(generatedPath(f.definition, path), false);
    }
  });
});

test('teardown preserves unrelated Issues and PRs even with copied markers', async t => {
  const f = await fixture(t);
  await setupAll(f);
  const unrelated = { id: 999, state: 'open', body: f.definition.marker };
  f.resources.set(999, unrelated);
  f.resources.set(998, { ...unrelated, id: 998, kind: 'pull' });
  const before = structuredClone([...f.resources]
    .filter(([id]) => id === 998 || id === 999));
  const result = await f.lifecycle().teardown();
  assert.equal(result.state, 'passing');
  assert.deepEqual([...f.resources].filter(([id]) => id === 998 || id === 999), before);
  assert.deepEqual(f.writes.slice(3),
    [['cleanup', 'pull'], ['cleanup', 'branch'], ['cleanup', 'issue']]);
  assert.ok(result.resources.every(record => record.state === 'cleaned'));
});

test('every creation intent is durable before provider mutation', async t => {
  const f = await fixture(t);
  const original = f.api.create;
  f.api.create = async record => {
    const saved = (await records(f)).resources[0];
    assert.equal(saved.operation, record.operation);
    assert.equal(saved.state, 'intent');
    assert.equal(saved.native, null);
    return original(record);
  };
  assert.equal((await f.lifecycle().setup('issue')).state, 'passing');
  assert.equal((await records(f)).resources[0].cleanup, 'close-issue');
});

test('lost response never repeats creation or permits destructive cleanup', async t => {
  const f = await fixture(t);
  const original = f.api.create;
  f.api.create = async record => { await original(record); throw new Error('SECRET'); };
  const result = await f.lifecycle().setup('issue');
  assert.equal(result.state, 'unverified');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal((await f.lifecycle().setup('issue')).state, 'unverified');
  assert.equal((await f.lifecycle().teardown()).state, 'unverified');
  assert.equal((await f.lifecycle().reconcile()).state, 'unverified');
  assert.equal(f.writes.length, 1);
  assert.equal((await records(f)).resources[0].state, 'unknown');
});

test('protected native receipt reconciles interrupted setup across lifecycle instances',
  async t => {
    let receipt;
    const f = await fixture(t, { created: (record, native) => {
      receipt = { operation: record.operation, native };
    } });
    const original = f.api.create;
    f.api.create = async record => { await original(record); throw new Error('lost'); };
    await f.lifecycle().setup('issue');
    f.context.receipt = async () => receipt;
    assert.equal((await f.lifecycle().reconcile()).state, 'passing');
    assert.equal(f.writes.length, 1);
    assert.equal((await f.lifecycle().teardown()).state, 'passing');
  });

test('restart confirms a persisted native identity without discovery or re-creation',
  async t => {
    const f = await fixture(t);
    await f.lifecycle().setup('issue');
    await change(f, state => { state.resources[0].state = 'intent'; });
    assert.equal((await f.lifecycle().reconcile()).state, 'passing');
    assert.equal(f.writes.length, 1);
  });

test('concurrent owners cannot reconcile each other using names or receipts', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  await first.lifecycle().setup('issue');
  await second.lifecycle().setup('issue');
  assert.notEqual(first.definition.owner, second.definition.owner);
  assert.notEqual(first.definition.name, second.definition.name);
  await change(second, state => {
    state.resources[0].native = null;
    state.resources[0].state = 'unknown';
  });
  const record = (await records(first)).resources[0];
  second.context.receipt = async () => ({ operation: record.operation,
    native: [...first.resources.values()][0] });
  assert.equal((await second.lifecycle().reconcile()).state, 'unverified');
  assert.equal((await second.lifecycle().teardown()).state, 'unverified');
  assert.equal(second.writes.length, 1);
});

test('authorization, actor, denied reads and native identity mismatch prevent writes',
  async t => {
    for (const failure of ['authorization', 'actor', 'read', 'identity', 'incomplete']) {
      const f = await fixture(t);
      await f.lifecycle().setup('issue');
      if (failure === 'authorization') f.context.authorize = async () => false;
      if (failure === 'actor') f.api.preflight = async () => 8;
      if (failure === 'read') f.api.read = async () => { throw new Error('denied'); };
      if (failure === 'identity') [...f.resources.values()][0].user.id = 8;
      if (failure === 'incomplete') delete [...f.resources.values()][0].state;
      assert.equal((await f.lifecycle().teardown()).state, 'unverified');
      assert.equal(f.writes.length, 1);
    }
    const f = await fixture(t);
    f.context.authorize = async () => false;
    assert.equal((await f.lifecycle().setup('issue')).state, 'unverified');
    assert.equal(f.writes.length, 0);
  });

test('merged PR and branch history is explicitly retained', async t => {
  const f = await fixture(t);
  await setupAll(f);
  for (const resource of f.resources.values()) {
    resource.merged = true;
    if (resource.object) resource.object.sha = 'b'.repeat(40);
  }
  const result = await f.lifecycle().teardown();
  assert.equal(result.state, 'passing');
  assert.deepEqual(result.resources.filter(record => record.kind !== 'issue')
    .map(record => record.disposition), ['merged-history', 'merged-history']);
  assert.deepEqual(f.writes.slice(3), [['cleanup', 'issue']]);
});

test('running or unknown work, changed branches and missing merge state block cleanup',
  async t => {
    for (const value of [false, undefined]) {
      const f = await fixture(t);
      await setupAll(f);
      f.context.idle = async () => value;
      assert.equal((await f.lifecycle().teardown()).state, 'unverified');
      assert.equal(f.writes.length, 3);
    }
    const f = await fixture(t);
    await f.lifecycle().setup('branch', { sha });
    f.resources.get(f.definition.name).object.sha = 'b'.repeat(40);
    assert.equal((await f.lifecycle().teardown()).state, 'unverified');
    assert.equal(f.writes.length, 1);
    delete f.resources.get(f.definition.name).merged;
    assert.equal((await f.lifecycle().teardown()).state, 'unverified');
  });

test('unknown cleanup blocks all further deletion until its terminal effect is observed',
  async t => {
    const f = await fixture(t);
    await setupAll(f);
    const cleanup = f.api.cleanup;
    f.api.cleanup = async () => { throw new Error('lost'); };
    assert.equal((await f.lifecycle().teardown()).state, 'unverified');
    assert.equal((await f.lifecycle().reconcile()).state, 'unverified');
    assert.equal((await f.lifecycle().teardown()).state, 'unverified');
    const pending = (await records(f)).resources.find(r => r.state === 'cleanup-intent');
    await cleanup(pending);
    assert.equal((await f.lifecycle().reconcile()).state, 'passing');
    f.api.cleanup = cleanup;
    assert.equal((await f.lifecycle().teardown()).state, 'passing');
  });

test('timeouts and request/operation limits never manufacture success', async t => {
  const f = await fixture(t, { bounds: { requestTimeoutMs: 10 } });
  f.api.create = () => new Promise(() => {});
  assert.equal((await f.lifecycle().setup('issue')).state, 'unverified');
  assert.equal((await f.lifecycle().teardown()).state, 'unverified');
  for (const bounds of [{ requests: 1 }, { operations: 1 }]) {
    const f = await fixture(t, { bounds });
    if (bounds.operations) await setupAll(f);
    const result = bounds.operations ? await f.lifecycle().teardown() :
      await f.lifecycle().setup('issue');
    assert.equal(result.state, 'unverified');
  }
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    assert.throws(() => fixtureBudget({ timeoutMs }));
  }
});

test('inventory outlives worker cleanup, refuses overlap and serializes a single owner',
  async t => {
    const f = await fixture(t);
    await assert.rejects(fixtureInventory(join(f.root, 'worker', 'ledger'),
      f.definition, 7, join(f.root, 'worker')));
    let release;
    const held = f.inventory.exclusive(() =>
      new Promise(resolve => { release = resolve; }));
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(f.inventory.exclusive(() => {}), { code: 'EEXIST' });
    release();
    await held;
    await access(f.inventory.path);
    await assert.rejects(access(`${f.inventory.path}.lock`), { code: 'ENOENT' });
  });

test('inventory refuses worker aliases through symbolic links', async t => {
  const f = await fixture(t);
  const worker = join(f.root, 'worker');
  const alias = join(f.root, 'alias');
  await mkdir(worker);
  await symlink(worker, alias, 'dir');
  await assert.rejects(fixtureInventory(join(alias, 'ledger'), f.definition, 7, worker));
});

test('fixture selection cannot enlarge exact operation and target grants', async t => {
  const f = await fixture(t);
  const requests = [];
  f.context.authorize = async request => {
    requests.push(request);
    return request.repository === defaultTarget && request.operation === 'create-issue';
  };
  assert.equal((await f.lifecycle().setup('issue')).state, 'passing');
  const denied = await f.lifecycle().teardown();
  assert.equal(denied.reason, 'FIXTURE_AUTHORIZATION_DENIED');
  assert.equal((await records(f)).lastResult.reason, 'FIXTURE_AUTHORIZATION_DENIED');
  assert.deepEqual(requests.map(request => request.operation),
    ['create-issue', 'close-issue']);
  assert.ok(requests.every(request => request.repository === defaultTarget &&
    request.actor === 7 && request.owner === f.definition.owner));
  assert.equal(f.writes.length, 1);
});

test('confirmed native identity survives marker edits without adopting copied markers',
  async t => {
    const f = await fixture(t);
    await f.lifecycle().setup('issue');
    [...f.resources.values()][0].body = 'Maintained current Issue body';
    assert.equal((await f.lifecycle().teardown()).state, 'passing');
    assert.equal(f.writes.length, 2);
  });
