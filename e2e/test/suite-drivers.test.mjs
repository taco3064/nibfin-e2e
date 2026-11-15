import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCoverageFixture } from './release-coverage-support.mjs';
import { pairedFixture } from './delivery-pair-support.mjs';
import { faultFixture } from './fault-support.mjs';
import { createSuite } from '../suite-drivers.mjs';
import { suiteProducers } from '../suite-producers.mjs';

async function composition(t) {
  const f = await releaseCoverageFixture(t);
  const state = await f.cli.read();
  const d = state.definition;
  const native = new Map(state.repositories.map(row => [row.repository, {
    id: row.native.id, full_name: row.repository,
    owner: { ...d.account, type: 'User' }, description: d.marker,
    default_branch: 'main', archived: false, disabled: false,
  }]));
  const absent = new Set();
  let excluded = false;
  let revoked = false;
  const context = {
    authorize: async () => true,
    exclude: async () => { excluded = true; },
    execution: async () => ({ excluded, settled: true, effects: 'reconciled' }),
    discover: async state => ({ complete: true,
      targets: (state.installation?.runners ?? []).map(runner => ({
        kind: 'registration', id: String(runner.id), owner: d.owner,
        hostId: f.cli.binding.hostId,
      })) }),
    observe: async target => ({ ...target, independent: true, complete: true,
      owned: true, active: false, absent: absent.has(target.id) }),
    mutate: async (operation, target) => {
      assert.equal(operation, 'remove');
      absent.add(target.id);
    },
    baseline: async () => true,
    repository: async record => ({ independent: true, complete: true,
      access: 'verified', repository: record.repository, id: record.native.id,
      accountId: d.account.id, absent: !native.has(record.repository),
      native: native.get(record.repository) }),
    deleteRepository: async record => {
      assert.equal(excluded, true);
      native.delete(record.repository);
    },
    receipt: async () => null,
    credentials: { revoke: async () => {
      revoked = true;
      return { status: 'revoked' };
    } },
  };
  const result = () => ({ state: 'passed', code: 'CONTROLLED', resources: [] });
  const options = { inventory: f.cli.inventory, prepared: f.prepared,
    provenance: 'controlled', binding: 'test/release/123/1',
    verifyOwnership: async owner => owner === f.prepared,
    repository: { context: { authorize: async () => true, idle: async () => true },
      provider: () => ({ preflight: async () => d.account.id,
        observe: async record => native.get(record.repository),
        seedObserved: async () => true,
        createRepository: () => assert.fail('must reuse existing repositories'),
        seedRepository: () => assert.fail('must reuse verified seeds') }) },
    installation: { context: f.cli.context }, teardown: { context },
    delivery: { execute: result, reconcile: result },
    failure: { execute: result, reconcile: result } };
  return { ...f, options, native, isRevoked: () => revoked };
}

test('suite composes maintained drivers using one inventory without nested locks',
  async t => {
    const f = await composition(t);
    const request = { runId: 'real-driver-composition', phase: 'provision' };
    const first = await createSuite(f.options).run(request);
    assert.equal(first.phases.provision.state, 'passed');
    assert.equal(f.native.size, 2);
    const result = await createSuite(f.options).run({ runId: request.runId,
      resume: true });
    assert.equal(result.outcome, 'passed', JSON.stringify(result));
    assert.equal(f.native.size, 0);
    assert.equal(f.isRevoked(), true);
    assert.equal(f.cli.commands.length, 1);
    assert.equal(f.prepared.disposed, false);
    const state = await f.cli.read();
    assert.equal(state.teardown.complete, true);
    assert.equal(state.suite.runId, request.runId);
  });

test('cleanup can run independently when other phase capabilities are absent',
  async t => {
    const f = await composition(t);
    delete f.options.repository;
    delete f.options.installation;
    delete f.options.delivery;
    delete f.options.failure;
    const result = await createSuite(f.options).run({ runId: 'cleanup-only',
      phase: 'cleanup' });
    assert.equal(result.cleanup, 'complete');
    assert.equal(result.phases.provision.state, 'unobserved');
    assert.equal(result.outcome, 'non-passing');
    assert.equal(f.native.size, 0);
  });

test('controlled contexts cannot be labelled native by maintained composition',
  async t => {
    const f = await composition(t);
    assert.throws(() => createSuite({ ...f.options, provenance: 'native' }),
      /NATIVE_COMPOSITION/);
  });

test('suite producers borrow original sources for paired delivery and fault recovery',
  async () => {
    const pair = pairedFixture();
    const fault = faultFixture();
    const owner = { disposed: false, sources: {}, root: '/original-owned-sources' };
    const request = { repository: 'fixture/repository',
      assignee: { id: 7, login: 'target-actor' } };
    const context = { intent: 'saved-intent', prepared: owner };
    const seen = [];
    const spec = (caller, request) => ({ request,
      open: async actual => {
        assert.equal(actual, context);
        return { caller: { ...caller, trigger: async (binding, signal) => {
          seen.push(binding.sourceRoot);
          return caller.trigger(binding, signal);
        } }, resources: ['fixture/repository'] };
      },
      reconcile: () => assert.fail('not recovering'),
    });
    const drivers = suiteProducers({
      delivery: spec(pair.caller, request),
      failure: spec(fault.caller, { ...request, case: 'failed-ci' }),
    });
    assert.equal((await drivers.delivery.execute(context)).state, 'passed');
    assert.equal((await drivers.failure.execute(context)).state, 'passed');
    assert.deepEqual(seen, Array(4).fill(owner.root));
    assert.equal(owner.disposed, false);
    assert.equal(fault.ledgers[0].faultExecution.sourceRoot, owner.root);
  });

test('producer recovery calls only independent reconciler and checks provenance',
  async () => {
    const pending = { state: 'unresolved', code: 'UNKNOWN', resources: ['run/42'] };
    const spec = { open: () => assert.fail('must not start a replacement'),
      reconcile: async () => pending };
    const drivers = suiteProducers({ delivery: spec, failure: spec });
    assert.equal(await drivers.delivery.reconcile({ intent: 'existing' }), pending);
    const changed = suiteProducers({ provenance: 'native',
      delivery: { ...spec, open: async () => ({ caller: { mode: 'fixture' } }) },
      failure: spec });
    const result = await changed.delivery.execute({});
    assert.equal(result.state, 'unresolved');
    assert.equal(result.code, 'PROVENANCE_MISMATCH');
  });
