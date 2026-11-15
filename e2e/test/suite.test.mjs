import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { protectedSuite } from '../suite.mjs';
import { suitePhases, requireNativeSuite } from '../suite-result.mjs';
import { sourceRepositories } from '../source-checkout.mjs';
import { runSuite } from '../runner.mjs';

const runId = 'suite-test-1';
const binding = 'taco3064/nibfin-e2e/123/1';
const sources = () => Object.fromEntries(sourceRepositories.map(row =>
  [row.id, { ...row, commit: 'a'.repeat(40) }]));
const passed = (resources = []) => ({ state: 'passed', code: 'OBSERVED', resources });

async function fixture(check, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-suite-test-'));
  const definition = { owner: 'suite-test-owner' };
  const inventory = await fixtureInventory(join(root, 'recovery'), definition,
    1, join(root, 'worker'));
  const calls = [];
  const prepared = { sources: sources(), disposed: false, ownershipId: 'owner-1' };
  const drivers = Object.fromEntries(suitePhases.map(phase => [phase, {
    async execute(context) {
      const state = JSON.parse(await readFile(inventory.path, 'utf8'));
      assert.equal(state.suite.runId, runId);
      assert.equal(state.suite.phases[phase].intent, context.intent);
      calls.push(`${phase}:execute`);
      return passed(phase === 'provision' ? ['owner/repository'] : []);
    },
    async reconcile(context) {
      assert.ok(context.intent);
      calls.push(`${phase}:reconcile`);
      return passed();
    },
  }]));
  const options = { inventory, prepared, binding,
    verifyOwnership: async () => true, compose: () => drivers, ...overrides };
  const coordinator = () => protectedSuite(options);
  try {
    await check({ root, inventory, calls, drivers, prepared, options, coordinator });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('complete suite persists identity before effects and never upgrades provenance',
  async () => fixture(async ({ coordinator, calls }) => {
    const document = await runSuite(coordinator(), { runId });
    assert.equal(document.outcome, 'passed');
    assert.equal(document.provenance, 'controlled');
    assert.equal(document.cleanup, 'complete');
    assert.deepEqual(document.pending, []);
    assert.deepEqual(calls, suitePhases.map(phase => `${phase}:execute`));
    assert.throws(() => requireNativeSuite(document, {
      sources: sources(), ownershipId: 'owner-1',
    }, {
      repository: 'taco3064/nibfin-e2e', runId: '123', attempt: '1',
    }), /SUITE/);
  }));

test('each independent phase names missing input without executing upstream',
  async () => {
    for (const [phase, missing] of [['install', 'provision'],
      ['delivery', 'install'], ['failure', 'delivery']]) {
      await fixture(async ({ coordinator, calls }) => {
        const result = await coordinator().run({ runId, phase });
        assert.equal(result.outcome, 'non-passing');
        assert.equal(result.phases[phase].state, 'missing-input');
        assert.equal(result.phases[phase].code, `MISSING_${missing.toUpperCase()}`);
        assert.deepEqual(calls, []);
        assert.equal(result.phases.cleanup.state, 'unobserved');
      });
    }
  });

test('restart after provision reuses native identity and reconciles without create',
  async () => fixture(async ({ coordinator, calls, inventory, drivers }) => {
    const native = { repository: 'owner/repository', id: 200 };
    drivers.provision.execute = async ({ inventory: scoped }) => {
      await scoped.exclusive(async (state, save) => {
        state.repositories = [native];
        await save();
      });
      calls.push('create');
      return passed(['owner/repository']);
    };
    drivers.provision.reconcile = async ({ inventory: scoped }) => {
      await scoped.exclusive(async state => {
        assert.deepEqual(state.repositories, [native]);
      });
      calls.push('read');
      return passed(['owner/repository']);
    };
    await coordinator().run({ runId, phase: 'provision' });
    const result = await coordinator().run({ runId, resume: true });
    assert.equal(result.outcome, 'passed');
    assert.equal(calls.filter(call => call === 'create').length, 1);
    assert.equal(calls.filter(call => call === 'read').length, 1);
    assert.deepEqual(JSON.parse(await readFile(inventory.path, 'utf8'))
      .repositories, [native]);
  }));

test('dispatch interruption retains intent and execution; resume only reconciles',
  async () => fixture(async ({ coordinator, calls, drivers }) => {
    await coordinator().run({ runId, phase: 'provision' });
    await coordinator().run({ runId, phase: 'install', resume: true });
    let intent;
    drivers.delivery.execute = async context => {
      intent = context.intent;
      await context.checkpoint('native-run/42/1/job/99');
      calls.push('dispatch');
      throw new Error('secret provider diagnostic');
    };
    drivers.delivery.reconcile = async context => {
      assert.equal(context.intent, intent);
      assert.equal(context.execution, 'native-run/42/1/job/99');
      calls.push('read-native');
      return passed(['issue/12']);
    };
    const interrupted = await coordinator().run({ runId, phase: 'delivery',
      resume: true });
    assert.equal(interrupted.phases.delivery.state, 'unresolved');
    assert.ok(interrupted.pending.includes(intent));
    assert.ok(!JSON.stringify(interrupted).includes('secret'));
    const resumed = await coordinator().run({ runId, resume: true });
    assert.equal(resumed.outcome, 'passed');
    assert.equal(calls.filter(value => value === 'dispatch').length, 1);
    assert.equal(calls.filter(value => value === 'read-native').length, 1);
  }));

test('unknown effects stay pending and complete route enters protected cleanup',
  async () => fixture(async ({ coordinator, drivers, calls }) => {
    drivers.delivery.execute = async context => {
      await context.checkpoint('native-run/unknown');
      return { state: 'unresolved', code: 'EFFECTS_UNKNOWN',
        resources: ['issue/12', 'host/worker'] };
    };
    drivers.delivery.reconcile = drivers.delivery.execute;
    drivers.cleanup.execute = async () => {
      calls.push('cleanup');
      return { state: 'unresolved', code: 'SETTLEMENT_REQUIRED',
        resources: ['host/worker'] };
    };
    const result = await coordinator().run({ runId });
    assert.equal(result.outcome, 'non-passing');
    assert.equal(result.phases.failure.state, 'unobserved');
    assert.equal(result.cleanup, 'pending');
    assert.ok(result.pending.includes('host/worker'));
    assert.ok(calls.includes('cleanup'));
  }));

test('failed work still enters cleanup and cannot become complete success',
  async () => fixture(async ({ coordinator, drivers }) => {
    drivers.install.execute = async () => ({ state: 'failed',
      code: 'INSTALL_REFUSED', resources: [] });
    const result = await coordinator().run({ runId });
    assert.equal(result.phases.install.state, 'failed');
    assert.equal(result.cleanup, 'complete');
    assert.equal(result.outcome, 'non-passing');
  }));

test('run/source/binding conflicts reject before driver mutation',
  async () => fixture(async ({ coordinator, prepared, calls, options }) => {
    await coordinator().run({ runId, phase: 'provision' });
    const count = calls.length;
    await assert.rejects(coordinator().run({ runId: 'other', resume: true }),
      /BINDING_CONFLICT/);
    await assert.rejects(coordinator().run({ runId }), /BINDING_CONFLICT/);
    prepared.sources.core.commit = 'b'.repeat(40);
    await assert.rejects(coordinator().run({ runId, resume: true }),
      /BINDING_CONFLICT/);
    prepared.sources.core.commit = 'a'.repeat(40);
    options.binding = 'other/invocation';
    await assert.rejects(coordinator().run({ runId, resume: true }),
      /BINDING_CONFLICT/);
    assert.equal(calls.length, count);
  }));

test('missing original source ownership never falls back or reports stale success',
  async () => fixture(async ({ coordinator, prepared, calls }) => {
    await coordinator().run({ runId });
    const count = calls.length;
    prepared.disposed = true;
    const result = await coordinator().run({ runId, resume: true });
    assert.equal(result.outcome, 'non-passing');
    assert.equal(result.reason, 'ORIGINAL_SOURCES_UNAVAILABLE');
    assert.equal(calls.length, count);
  }));

test('timeout retains lock; abort is not proof of termination', async () => {
  let settle;
  await fixture(async ({ coordinator, drivers, inventory }) => {
    drivers.provision.execute = () => new Promise(resolve => { settle = resolve; });
    const result = await coordinator().run({ runId });
    assert.equal(result.phases.provision.state, 'unresolved');
    assert.equal(result.phases.cleanup.code, 'EXECUTION_STILL_PENDING');
    await access(`${inventory.path}.lock`);
    await assert.rejects(coordinator().run({ runId, resume: true }),
      { code: 'EEXIST' });
    settle(passed());
  }, { bounds: { requestTimeoutMs: 20, timeoutMs: 200 } });
});

test('concurrent coordinators cannot both mutate the same inventory',
  async () => fixture(async ({ coordinator, drivers }) => {
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    drivers.provision.execute = async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      return passed();
    };
    const first = coordinator().run({ runId, phase: 'provision' });
    await entered;
    await assert.rejects(coordinator().run({ runId, phase: 'provision' }),
      { code: 'EEXIST' });
    release();
    await first;
  }));

test('operation bounds stop progress and leave cleanup visibly non-passing',
  async () => fixture(async ({ coordinator }) => {
    const result = await coordinator().run({ runId });
    assert.equal(result.outcome, 'non-passing');
    assert.equal(result.phases.install.code, 'SUITE_BOUND_EXHAUSTED');
    assert.equal(result.phases.cleanup.state, 'unresolved');
  }, { bounds: { operations: 1 } }));

test('malformed observations and credentials are not serialized',
  async () => fixture(async ({ coordinator, drivers }) => {
    drivers.provision.execute = async () => ({ ...passed(),
      credentials: { token: 'secret-value' }, diagnostic: 'secret-error' });
    const result = await coordinator().run({ runId, phase: 'provision' });
    assert.equal(result.phases.provision.state, 'passed');
    assert.ok(!JSON.stringify(result).includes('secret'));
    drivers.provision.reconcile = async () => ({ state: 'passed',
      code: 'OK', resources: [{ token: 'secret-value' }] });
    const invalid = await coordinator().run({ runId, phase: 'provision',
      resume: true });
    assert.equal(invalid.phases.provision.state, 'unresolved');
    assert.ok(!JSON.stringify(invalid).includes('secret'));
  }));


test('stale completed upstream observation blocks downstream execution',
  async () => fixture(async ({ coordinator, drivers, calls }) => {
    await coordinator().run({ runId, phase: 'provision' });
    await coordinator().run({ runId, phase: 'install', resume: true });
    drivers.provision.reconcile = async () => ({ state: 'unresolved',
      code: 'NATIVE_IDENTITY_MISSING', resources: ['owner/repository'] });
    const result = await coordinator().run({ runId, phase: 'delivery', resume: true });
    assert.equal(result.phases.delivery.code, 'MISSING_PROVISION');
    assert.equal(calls.includes('delivery:execute'), false);
  }));

test('driver retention is not treated as permission to race cleanup',
  async () => fixture(async ({ coordinator, drivers, calls }) => {
    drivers.provision.execute = async ({ inventory }) => {
      await inventory.exclusive(async (state, save, retain) => { retain(); });
      return passed();
    };
    const result = await coordinator().run({ runId });
    assert.equal(result.outcome, 'non-passing');
    assert.equal(result.phases.provision.state, 'unresolved');
    assert.equal(calls.includes('cleanup:execute'), false);
  }));

test('source owner and original checkout locations cannot be substituted on resume',
  async () => fixture(async ({ coordinator, prepared, calls }) => {
    prepared.root = '/owned/source-root';
    await coordinator().run({ runId, phase: 'provision' });
    const count = calls.length;
    prepared.root = '/replacement/source-root';
    await assert.rejects(coordinator().run({ runId, resume: true }),
      /BINDING_CONFLICT/);
    prepared.root = '/owned/source-root';
    prepared.ownershipId = 'replacement-owner';
    await assert.rejects(coordinator().run({ runId, resume: true }),
      /BINDING_CONFLICT/);
    assert.equal(calls.length, count);
  }));

test('missing execution capability is non-passing and still enters cleanup',
  async () => fixture(async ({ coordinator, drivers }) => {
    delete drivers.install;
    const result = await coordinator().run({ runId });
    assert.equal(result.phases.install.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(result.phases.install.state, 'unresolved');
    assert.equal(result.cleanup, 'complete');
    assert.equal(result.outcome, 'non-passing');
  }));

test('cleanup interruption resumes reconciliation using the original cleanup intent',
  async () => fixture(async ({ coordinator, drivers }) => {
    let attempts = 0;
    let intent;
    drivers.cleanup.execute = async context => {
      attempts++;
      intent = context.intent;
      return { state: 'unresolved', code: 'REVOCATION_PENDING',
        resources: ['credential-session/1'] };
    };
    drivers.cleanup.reconcile = async context => {
      assert.equal(context.intent, intent);
      return passed();
    };
    const first = await coordinator().run({ runId });
    assert.equal(first.cleanup, 'pending');
    assert.ok(first.pending.includes('credential-session/1'));
    const recovered = await coordinator().run({ runId, phase: 'cleanup',
      resume: true });
    assert.equal(recovered.outcome, 'passed');
    assert.equal(attempts, 1);
    assert.deepEqual(recovered.pending, []);
  }));


test('unavailable original owner returns structured recovery evidence',
  async () => fixture(async ({ coordinator, options, calls }) => {
    const original = await coordinator().run({ runId, phase: 'provision' });
    options.prepared = undefined;
    const count = calls.length;
    const result = await coordinator().run({ runId, resume: true });
    assert.equal(result.outcome, 'non-passing');
    assert.equal(result.reason, 'ORIGINAL_SOURCES_UNAVAILABLE');
    assert.deepEqual(result.sources, original.sources);
    assert.equal(result.sourceOwner, original.sourceOwner);
    assert.equal(result.phases.provision.state, 'unresolved');
    assert.equal(calls.length, count);
  }));
