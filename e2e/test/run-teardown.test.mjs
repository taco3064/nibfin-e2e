import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { repositoryDefinition, repositoryNative } from '../repository-definition.mjs';
import { protectedRunTeardown } from '../run-teardown.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-teardown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const d = repositoryDefinition({ id: 7, login: 'test-user' }, 'test-user/control');
  const inventory = await fixtureInventory(join(root, 'recovery'), d, 7,
    join(root, 'worker'));
  const native = d.repositories.map((name, i) => ({ id: i + 10, full_name: name,
    owner: { id: 7, login: 'test-user', type: 'User' }, description: d.marker,
    archived: false, disabled: false, default_branch: 'main' }));
  await inventory.exclusive(async (s, save) => {
    s.repositories = native.map(n => ({ repository: n.full_name, marker: d.marker,
      account: d.account, native: repositoryNative(n), operation: String(n.id) }));
    await save();
  });
  const targets = ['service', 'registration'].map((kind, i) => ({
    kind, id: String(i + 1), hostId: 'host', owner: d.owner,
  }));
  const effects = new Map();
  const writes = [];
  const options = {};
  let excluded = false;
  let settled = false;
  const removed = new Set();
  const context = {
    authorize: async () => true,
    exclude: async () => { excluded = true; },
    execution: async () => ({ excluded, settled: settled || options.noRuns === true,
      effects: 'reconciled' }),
    discover: async () => ({ complete: true, targets }),
    baseline: async () => options.baseline !== false,
    observe: async target => ({ ...target, independent: true, complete: true,
      owned: options.owned !== false, active: false,
      stopped: effects.get(target.id) === 'stop',
      absent: effects.get(target.id) === 'remove' }),
    mutate: async (operation, target) => {
      const s = JSON.parse(await readFile(inventory.path, 'utf8'));
      assert.ok(s.teardown.operations.some(o => o.operation === operation));
      writes.push(operation);
      if (operation === 'settle') settled = true;
      else effects.set(target.id, operation);
      if (options.lost === operation) throw new Error('PRIVATE PROVIDER OUTPUT');
    },
    repository: async r => ({ independent: true, complete: true,
      access: options.denied ? 'denied' : 'verified', repository: r.repository,
      id: r.native.id, accountId: 7, absent: removed.has(r.native.id),
      native: { ...native.find(n => n.id === r.native.id), ...options.native } }),
    deleteRepository: async r => {
      assert.equal(excluded && (settled || options.noRuns === true), true);
      writes.push('delete');
      removed.add(r.native.id);
      if (options.lost === 'delete') throw new Error('PRIVATE PROVIDER OUTPUT');
    },
    receipt: async () => null,
    credentials: { revoke: async () => ({ status: 'revoked' }) },
  };
  return { inventory, context, options, writes, targets,
    run: bounds => protectedRunTeardown({ inventory, context, bounds }).teardown() };
}

test('teardown without delivery settles execution and repeats', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).state, 'complete');
  assert.deepEqual(f.writes, ['settle', 'stop', 'remove', 'remove', 'delete', 'delete']);
  const before = [...f.writes];
  assert.equal((await f.run()).state, 'complete');
  assert.deepEqual(f.writes, before);
});

for (const native of [{ id: 999 }, { description: 'copied' },
  { owner: { id: 99, login: 'other', type: 'User' } }]) {
  test(`repository identity contradiction ${JSON.stringify(native)}`, async t => {
    const f = await fixture(t);
    f.options.native = native;
    assert.equal((await f.run()).state, 'unresolved');
    assert.equal(f.writes.includes('delete'), false);
  });
}

test('denied observer access never establishes absence', async t => {
  const f = await fixture(t);
  f.options.denied = true;
  assert.equal((await f.run()).state, 'unresolved');
  assert.equal(f.writes.includes('delete'), false);
});

test('unowned services and changed baseline prevent destructive removal', async t => {
  const f = await fixture(t);
  f.options.owned = false;
  assert.equal((await f.run()).state, 'unresolved');
  assert.deepEqual(f.writes, ['settle']);
  f.options.baseline = false;
  assert.equal((await f.run()).state, 'unresolved');
  assert.deepEqual(f.writes, ['settle']);
});

test('lost deletion response reconciles absence without repeating deletion', async t => {
  const f = await fixture(t);
  f.options.lost = 'delete';
  assert.equal((await f.run()).state, 'unresolved');
  delete f.options.lost;
  assert.equal((await f.run()).state, 'complete');
  assert.equal(f.writes.filter(w => w === 'delete').length, 2);
});

test('unknown mutation never replays until terminal observation', async t => {
  const f = await fixture(t);
  const mutate = f.context.mutate;
  f.context.mutate = async (...args) => {
    if (args[0] === 'settle') return mutate(...args);
    throw new Error('secret');
  };
  assert.equal((await f.run()).state, 'unresolved');
  let retries = 0;
  f.context.mutate = async () => { retries++; };
  assert.equal((await f.run()).state, 'unresolved');
  assert.equal(retries, 0);
});

test('missing private credential session remains unresolved', async t => {
  const f = await fixture(t);
  delete f.context.credentials;
  const result = await f.run();
  assert.equal(result.state, 'unresolved');
  assert.equal(result.phase, 'credentials');
});

test('timeout retains the exclusive lock until protected recovery', async t => {
  const f = await fixture(t);
  let finish;
  f.context.exclude = () => new Promise(resolve => { finish = resolve; });
  assert.equal((await f.run({ requestTimeoutMs: 10 })).state, 'unresolved');
  await assert.rejects(f.inventory.exclusive(() => {}), { code: 'EEXIST' });
  finish();
  await new Promise(resolve => setImmediate(resolve));
});

test('partial creation needs an intent-bound native receipt', async t => {
  const f = await fixture(t);
  let native;
  await f.inventory.exclusive(async (s, save) => {
    const r = s.repositories[0];
    native = { id: r.native.id, full_name: r.repository, owner: {
      ...r.native.owner, type: 'User' }, description: r.marker,
    default_branch: 'main', archived: false, disabled: false };
    r.native = null;
    r.creation = 'unresolved';
    s.installation = { binding: { hostId: 'host' }, runners: [{ id: 2 }],
      pending: { operation: 'init', sequence: 1 } };
    await save();
  });
  assert.equal((await f.run()).state, 'unresolved');
  f.context.receipt = async r => ({ operation: r.operation, native });
  assert.equal((await f.run()).state, 'complete');
});

test('late inventory additions cannot disappear from host discovery', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).state, 'complete');
  await f.inventory.exclusive(async (s, save) => {
    s.installation = { binding: { hostId: 'host' }, runners: [{ id: 99 }] };
    await save();
  });
  assert.equal((await f.run()).state, 'unresolved');
});

test('existing fixture cleanup is required when delivery added resources', async t => {
  const f = await fixture(t);
  await f.inventory.exclusive(async (s, save) => {
    s.resources.push({ kind: 'issue', state: 'owned', cleanup: 'close-issue',
      native: { id: 123, number: 1 } });
    await save();
  });
  assert.equal((await f.run()).phase, 'fixtures');
  let closed = false;
  f.context.fixtureContext = { authorize: async () => true, idle: async () => true };
  f.context.fixtureProvider = (_budget, definition) => ({
    preflight: async () => 7,
    read: async () => ({ id: 123, number: 1, user: { id: 7 },
      url: `https://api.github.com/repos/${definition.repository}/issues/1`,
      state: closed ? 'closed' : 'open' }),
    cleanup: async () => { closed = true; },
  });
  assert.equal((await f.run()).state, 'complete');
  assert.equal(closed, true);
});

test('budget exhaustion preserves the durable exclusion intent', async t => {
  const f = await fixture(t);
  f.options.noRuns = true;
  assert.equal((await f.run({ operations: 1 })).state, 'unresolved');
  const state = JSON.parse(await readFile(f.inventory.path, 'utf8'));
  assert.deepEqual(state.teardown.operations, [
    { key: 'run', operation: 'exclude', disposition: 'verified' },
  ]);
  assert.equal((await f.run()).state, 'complete');
});

test('uncertain revocation is unresolved and never replayed', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.context.credentials.revoke = async () => {
    calls++;
    return { status: 'unverified' };
  };
  assert.equal((await f.run()).state, 'unresolved');
  assert.equal((await f.run()).state, 'unresolved');
  assert.equal(calls, 1);
});

test('active registrations and incomplete discovery are preserved', async t => {
  const f = await fixture(t);
  const observe = f.context.observe;
  f.context.observe = async target => ({ ...await observe(target),
    active: target.kind === 'registration' });
  assert.equal((await f.run()).state, 'unresolved');
  assert.equal(f.writes.filter(w => w === 'remove').length, 1);
  f.context.discover = async () => ({ complete: false, targets: [] });
  assert.equal((await f.run()).state, 'unresolved');
  assert.equal(f.writes.includes('delete'), false);
});

test('credential-validation repository can never become a deletion target', async t => {
  const f = await fixture(t);
  await f.inventory.exclusive(async (s, save) => {
    s.repositories[0].repository = s.definition.repository;
    await save();
  });
  assert.equal((await f.run()).state, 'unresolved');
  assert.equal(f.writes.includes('delete'), false);
});

test('unknown settlement retains ownership and sanitizes diagnostics', async t => {
  const f = await fixture(t);
  f.context.mutate = async () => { throw new Error('PRIVATE PROVIDER OUTPUT'); };
  const result = await f.run();
  assert.equal(result.state, 'unresolved');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal((await readFile(f.inventory.path, 'utf8')).includes('PRIVATE'), false);
  await assert.rejects(f.inventory.exclusive(() => {}), { code: 'EEXIST' });
});


test('services precede registrations regardless of discovery order', async t => {
  const f = await fixture(t);
  f.targets.reverse();
  assert.equal((await f.run()).state, 'complete');
  assert.deepEqual(f.writes.slice(0, 4), ['settle', 'stop', 'remove', 'remove']);
});


test('lost revocation reconciles through the original private session', async t => {
  const f = await fixture(t);
  let revoked = false;
  let calls = 0;
  f.context.credentials.revoke = async () => {
    calls++;
    revoked = true;
    throw new Error('lost response');
  };
  f.context.credentials.capabilities = async () => ({
    automation: { status: revoked ? 'revoked' : 'usable' },
  });
  assert.equal((await f.run()).state, 'unresolved');
  assert.equal((await f.run()).state, 'complete');
  assert.equal(calls, 1);
});

for (const kind of ['service', 'registration']) {
  for (const moment of ['initial', 'after-mutation', 'repeat']) {
    test(`contradictory ${kind} absence at ${moment} blocks cleanup`, async t => {
      const f = await fixture(t);
      if (moment === 'repeat') assert.equal((await f.run()).state, 'complete');
      const before = [...f.writes];
      const observe = f.context.observe;
      f.context.observe = async target => {
        const o = await observe(target);
        const contradict = target.kind === kind &&
          (moment !== 'after-mutation' || o.absent);
        return contradict ? { ...o, absent: true, active: true } : o;
      };
      const result = await f.run();
      assert.equal(result.state, 'unresolved');
      assert.equal(result.phase, 'host');
      const writes = f.writes.slice(before.length);
      assert.equal(writes.includes('delete'), false);
      if (moment === 'repeat') assert.deepEqual(writes, []);
      if (moment === 'initial' && kind === 'service') {
        assert.deepEqual(writes, ['settle']);
      }
      const attempts = [...f.writes];
      assert.equal((await f.run()).state, 'unresolved');
      assert.deepEqual(f.writes, attempts);
    });
  }
}

test('active service cannot establish stopped state', async t => {
  const f = await fixture(t);
  const observe = f.context.observe;
  f.context.observe = async target => ({ ...await observe(target),
    ...(target.kind === 'service' ? { stopped: true, active: true } : {}) });
  assert.equal((await f.run()).state, 'unresolved');
  assert.deepEqual(f.writes, ['settle']);
});

for (const field of ['absent', 'active', 'stopped']) {
  test(`missing service ${field} fact remains unresolved`, async t => {
    const f = await fixture(t);
    const observe = f.context.observe;
    f.context.observe = async target => {
      const o = await observe(target);
      if (target.kind === 'service') delete o[field];
      return o;
    };
    assert.equal((await f.run()).state, 'unresolved');
    assert.deepEqual(f.writes, ['settle']);
  });
}
