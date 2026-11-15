import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixture-support.mjs';
import { issueMutation, mutationObserved } from '../fixture-issue.mjs';

const assignee = { id: 8, login: 'adopted-target' };
async function preparedFixture(t, edit = () => {}) {
  const f = await fixture(t);
  await f.lifecycle().setup('issue');
  const native = [...f.resources.values()][0];
  native.labels = [];
  native.assignees = [];
  const writes = [];
  f.api.mutateIssue = async record => {
    const saved = JSON.parse(await readFile(f.inventory.path, 'utf8'));
    assert.deepEqual(saved.resources[0].mutation, record.mutation);
    writes.push(record.mutation.kind);
    if (record.mutation.kind === 'edit-issue-body') native.body = record.mutation.body;
    if (record.mutation.kind === 'assign-issue') native.assignees = [assignee];
    if (record.mutation.kind === 'add-issue-label') native.labels = [{ name: 'scope' }];
    edit(record.mutation.kind, native);
  };
  return { f, native, writes };
}

test('durable preparation confirms English body and exact assignment before scope',
  async t => {
    const { f, native, writes } = await preparedFixture(t);
    const result = await f.lifecycle().prepareDelivery('Implement JavaScript.',
      assignee);
    assert.equal(result.state, 'passing', JSON.stringify(result));
    assert.deepEqual(writes, ['edit-issue-body', 'assign-issue', 'add-issue-label']);
    assert.equal(native.body, `${f.definition.marker}\nImplement JavaScript.`);
    assert.deepEqual(native.assignees, [assignee]);
    assert.deepEqual(native.labels, [{ name: 'scope' }]);
  });

for (const [name, edit] of Object.entries({
  'missing body read-back': (kind, n) => {
    if (kind === 'edit-issue-body') delete n.body;
  },
  'wrong assignment': (kind, n) => {
    if (kind === 'assign-issue') n.assignees = [{ ...assignee, id: 99 }];
  },
  'extra assignment': (kind, n) => {
    if (kind === 'assign-issue') n.assignees.push({ id: 99, login: 'other' });
  },
  'body changed after assignment': (kind, n) => {
    if (kind === 'assign-issue') n.body = 'unexpected body';
  },
  'eligibility already set': (kind, n) => {
    if (kind === 'assign-issue') n.labels.push({ name: 'scope' });
  },
})) {
  test(`preparation rejects ${name} without writing scope`, async t => {
    const { f, writes } = await preparedFixture(t, edit);
    const result = await f.lifecycle().prepareDelivery('Implement JavaScript.',
      assignee);
    assert.equal(result.state, 'unverified');
    assert.equal(writes.includes('add-issue-label'), false);
  });
}

test('unconfirmed assignment is never replayed and remains recoverable', async t => {
  const { f, native, writes } = await preparedFixture(t, (kind, n) => {
    if (kind === 'assign-issue') n.assignees = [];
  });
  const lifecycle = f.lifecycle();
  assert.equal((await lifecycle.prepareDelivery('Implement JavaScript.',
    assignee)).state, 'unverified');
  assert.equal((await lifecycle.prepareDelivery('Implement JavaScript.',
    assignee)).state, 'unverified');
  assert.equal((await lifecycle.teardown()).state, 'unverified');
  assert.deepEqual(writes, ['edit-issue-body', 'assign-issue']);
  native.assignees = [assignee];
  assert.equal((await lifecycle.reconcile()).state, 'passing');
  assert.equal((await lifecycle.teardown()).state, 'passing');
});

test('assignment rejects invalid declarations and mismatched native logins', () => {
  for (const value of [null, 'target', { id: 0, login: 'target' },
    { id: 8, login: '../escape' }]) {
    assert.throws(() => issueMutation({}, 'assign-issue', value));
  }
  assert.equal(mutationObserved({ state: 'open',
    assignees: [{ ...assignee, login: 'other' }] },
  { kind: 'assign-issue', assignee }), false);
});
