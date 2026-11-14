import test from 'node:test';
import assert from 'node:assert/strict';
import { createContractGate, createReleaseGate } from '../release-gate.mjs';
import { validateHandoff, validateVersion } from '../release-contract.mjs';
import { sourceRepositories } from '../source-checkout.mjs';
import { report, result } from '../schema.mjs';
import { run } from '../runner.mjs';

function fixture() {
  const expected = { repository: 'taco3064/nibfin-e2e',
    workflow: '.github/workflows/release.yml', environment: 'release' };
  const identity = { ...expected, authorized: true, event: 'workflow_dispatch',
    ref: 'refs/heads/main', actor: 'operator', runId: '123', attempt: '1' };
  const registry = ['core', 'action', 'cli'].map(id => ({
    id: `${id}.live`, group: 'release', title: `${id} contract`, timeoutMs: 1000,
    module: new URL('./fixtures/release.mjs', import.meta.url).href,
  }));
  const catalog = registry.map((entry, index) => ({
    id: entry.id, product: ['Core', 'Action', 'CLI'][index],
    category: 'release', scenarioIds: [entry.id],
  }));
  const sources = Object.fromEntries(sourceRepositories.map(source => [source.id,
    { ...source, commit: 'a'.repeat(40), checkout: '/disposable/path', output: {} }]));
  const state = { prepared: 0, ran: 0, disposed: 0 };
  const prepared = { sources, disposed: false,
    async preflightRelease(version) {
      assert.equal(version, '1.2.3');
      assert.equal(state.prepared, 1);
      assert.equal(this.disposed, false);
    }, async dispose() {
    state.disposed++;
    this.disposed = true;
  } };
  const observations = sourceRepositories.map(({ repository }) => ({
    repository, version: '1.2.3', complete: true, tags: [], releases: [],
    activePublications: [],
  }));
  const mains = sourceRepositories.map(({ repository, ref }) => ({
    repository, ref, complete: true, commit: 'a'.repeat(40),
  }));
  const capabilities = { expected, verifyInvocation: async () => identity,
    observeConflicts: async () => observations, observeMains: async () => mains };
  const dependencies = { catalog, registry,
    prepare: async () => { state.prepared++; return prepared; },
    run: async (selected, groups, options) => {
      state.ran++;
      assert.equal(options.sources, sources);
      assert.deepEqual(options.workerEnv, {});
      assert.deepEqual(groups, []);
      return report(selected.map(row => result(row, 'passed', 'PASS', 'executed')));
    } };
  return { expected, identity, capabilities, dependencies, prepared, state,
    observations, registry, catalog, sources, mains };
}
async function invoke(f, inputs = ['1.2.3']) {
  return createContractGate(f.capabilities, f.dependencies)(inputs);
}
async function blocked(f, pattern, inputs) {
  const actual = await invoke(f, inputs);
  assert.equal(actual.outcome, 'blocked');
  assert.equal(Object.hasOwn(actual, 'handoff'), false);
  assert.match(actual.reason, pattern);
  return actual;
}

test('positive path retains identities and disposes before handoff', async () => {
  const f = fixture();
  const actual = await invoke(f);
  assert.equal(actual.outcome, 'ready');
  assert.equal(actual.handoff.mode, 'contract-test');
  assert.equal(validateHandoff(actual.handoff), actual.handoff);
  assert.deepEqual(f.state, { prepared: 1, ran: 1, disposed: 1 });
  assert.deepEqual(actual.handoff.sources.map(row => row.commit),
    Array(3).fill('a'.repeat(40)));
  assert.doesNotMatch(JSON.stringify(actual), /checkout|disposable|output|authorized/);
});

test('accepts strict semver including prerelease and build', () => {
  for (const version of ['0.0.0', '1.2.3-rc.1+build.007', '1.2.3+001']) {
    assert.equal(validateVersion([version]), version);
  }
});
for (const inputs of [undefined, [], ['1.2.3', '2.0.0'], '1.2.3', [null],
  ['v1.2.3'], ['01.2.3'], ['1.2'], ['1.2.3-01'], ['1.2.3 '], ['1.2.3\n']]) {
  test(`rejects invalid or ambiguous version ${JSON.stringify(inputs)}`, async () => {
    const f = fixture();
    // Invoke directly to preserve undefined rather than the helper default.
    const actual = await createContractGate(f.capabilities, f.dependencies)(inputs);
    assert.equal(actual.outcome, 'blocked');
    assert.match(actual.reason, /VERSION/);
    assert.equal(f.state.prepared, 0);
  });
}

for (const patch of [null, true, {}, { authorized: false },
  ...['pull_request', 'push', 'schedule', 'release'].map(event => ({ event })),
  { ref: 'refs/tags/v1.2.3' }, { repository: 'other/repo' },
  { workflow: 'other.yml' }, { environment: 'ordinary' }, { runId: '' }]) {
  test(`rejects authorization/context ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    f.capabilities.verifyInvocation = async () =>
      patch && typeof patch === 'object' ? { ...f.identity, ...patch } : patch;
    if (patch && Object.keys(patch).length === 0) {
      f.capabilities.verifyInvocation = async () => patch;
    }
    await blocked(f, /AUTHORIZATION/);
    assert.equal(f.state.prepared, 0);
  });
}

test('requires trusted process functions rather than approval fields', () => {
  assert.throws(() => createReleaseGate({ authorized: true }), /CONFIGURATION/);
});
for (const id of [0, 1, 2]) {
  for (const kind of ['tags', 'releases', 'activePublications']) {
    test(`rejects ${kind} conflict in product ${id}`, async () => {
      const f = fixture();
      f.observations[id][kind] = ['v1.2.3'];
      await blocked(f, /CONFLICTS/);
      assert.equal(f.state.prepared, 0);
    });
  }
}
for (const modify of [
  f => f.observations.pop(),
  f => { f.observations[0] = f.observations[1]; },
  f => { f.observations[0].complete = false; },
  f => { f.observations[0].version = '2.0.0'; },
  f => { f.observations[0].tags = null; },
  f => { f.observations[0].releases = [null]; },
  f => { delete f.observations[0].activePublications; },
  f => { f.capabilities.observeConflicts = async () => { throw Error('offline'); }; },
]) {
  test('incomplete, malformed or unavailable observations fail closed', async () => {
    const f = fixture();
    modify(f);
    await blocked(f, /CONFLICTS|offline/);
    assert.equal(f.state.prepared, 0);
  });
}
for (const modify of [
  f => { f.dependencies.catalog = []; },
  f => { f.catalog[0].scenarioIds = []; },
  f => { f.dependencies.registry = []; },
  f => { f.catalog[0].scenarioIds = ['missing.scenario']; },
  f => { f.registry[0].policyReason = 'not live'; },
  f => { f.dependencies.catalog = f.catalog.slice(1); },
]) {
  test('rejects empty, unmapped, unregistered or excluded mandatory suite', async () => {
    const f = fixture();
    modify(f);
    await blocked(f, /COVERAGE/);
    assert.equal(f.state.prepared, 0);
  });
}
for (const outcome of ['failing', 'blocked', 'unverified', 'skipped-by-policy']) {
  test(`rejects mandatory ${outcome} despite generic runner exit semantics`, async () => {
    const f = fixture();
    f.dependencies.run = async selected => report(selected.map(row =>
      result(row, outcome, 'CONTRACT', 'controlled rejection')));
    await blocked(f, /EXECUTION/);
    assert.equal(f.state.disposed, 1);
  });
}
for (const modify of [
  doc => { doc.results.pop(); },
  doc => { doc.results = []; },
  doc => { doc.results.push(doc.results[0]); },
  doc => { doc.results[0].reason = null; },
  doc => { doc.results[0].group = 'wrong'; },
  doc => { doc.results[0].id = 'unknown'; },
  doc => { doc.errors.push('runner error'); },
  doc => { doc.errors.push(null); },
  doc => { doc.schemaVersion = 2; },
]) {
  test('rejects incomplete or invalid runner documents and disposes', async () => {
    const f = fixture();
    const execute = f.dependencies.run;
    f.dependencies.run = async (...args) => {
      const document = await execute(...args);
      modify(document);
      return document;
    };
    await blocked(f, /EXECUTION|runner|result|mismatch|scenario/i);
    assert.equal(f.state.disposed, 1);
  });
}

test('preparation and execution exceptions produce no handoff', async () => {
  for (const phase of ['prepare', 'run']) {
    const f = fixture();
    f.dependencies[phase] = async () => { throw Error(`${phase} failed`); };
    await blocked(f, /failed/);
    assert.equal(f.state.disposed, phase === 'run' ? 1 : 0);
  }
});

test('unknown source-command termination retains sources without a handoff', async () => {
  const f = fixture();
  f.dependencies.run = async () => {
    throw new Error('source command did not settle', {
      cause: Object.assign(new Error('group signal failed'), {
        terminationUnknown: true,
      }),
    });
  };
  await blocked(f, /did not settle/);
  assert.equal(f.state.disposed, 0);
  assert.equal(f.prepared.disposed, false);
});

for (const modify of [
  f => { f.mains.pop(); },
  f => { f.mains[0] = f.mains[1]; },
  f => { f.mains[0].complete = false; },
  f => { f.mains[0].commit = 'unknown'; },
  f => { f.mains[0].ref = 'refs/tags/main'; },
  f => { f.mains[0].commit = 'b'.repeat(40); },
  f => { f.capabilities.observeMains = async () => { throw Error('main offline'); }; },
]) {
  test('remote main observations must completely match the acquired source set',
    async () => {
    const f = fixture();
    modify(f);
    await blocked(f, /REMOTE_MAIN|main offline/);
    assert.equal(f.state.ran, 0);
    assert.equal(f.state.disposed, 1);
  });
}

test('fresh authoritative observations detect remote changes after mandatory E2E',
  async () => {
  const f = fixture();
  let reads = 0;
  f.capabilities.observeMains = async () => {
    reads++;
    return structuredClone(f.mains);
  };
  const execute = f.dependencies.run;
  f.dependencies.run = async (...args) => {
    const document = await execute(...args);
    // The in-memory prepared source identities remain unchanged.
    f.mains[2].commit = 'b'.repeat(40);
    return document;
  };
  await blocked(f, /REMOTE_MAIN: acquired main changed/);
  assert.equal(reads, 2);
  assert.equal(f.state.ran, 1);
  assert.equal(f.state.disposed, 1);
  assert.equal(f.sources.cli.commit, 'a'.repeat(40));
});

test('version conflicts and publication activity are reobserved after E2E', async () => {
  for (const kind of ['tags', 'releases', 'activePublications']) {
    const f = fixture();
    let reads = 0;
    f.capabilities.observeConflicts = async () => {
      reads++;
      if (reads === 2) f.observations[0][kind] = ['v1.2.3'];
      return structuredClone(f.observations);
    };
    await blocked(f, /CONFLICTS/);
    assert.equal(reads, 2);
    assert.equal(f.state.ran, 1);
    assert.equal(f.state.disposed, 1);
  }
});

test('rejects source substitutions and invalid source identity', async () => {
  for (const duringRun of [false, true]) {
    const f = fixture();
    const change = () => { f.sources.core.commit = 'b'.repeat(40); };
    if (duringRun) {
      const execute = f.dependencies.run;
      f.dependencies.run = async (...args) => {
        const document = await execute(...args);
        change();
        return document;
      };
    } else f.sources.core.ref = 'refs/tags/main';
    await blocked(f, /SOURCES/);
    assert.equal(f.state.disposed, 1);
  }
});
test('cleanup failures and unconfirmed disposal prevent success', async () => {
  for (const throws of [true, false]) {
    const f = fixture();
    f.prepared.dispose = async () => { if (throws) throw Error('remove failed'); };
    await blocked(f, /CLEANUP/);
  }
});
test('production refuses controlled inputs as live requirements', async () => {
  const f = fixture();
  const actual = await createReleaseGate(f.capabilities)(['1.2.3']);
  assert.equal(actual.outcome, 'blocked');
  assert.match(actual.reason, /COVERAGE/);
});
test('runtime handoff validator rejects malformed and path-bearing output', async () => {
  const actual = await invoke(fixture());
  for (const modify of [
    h => { h.checkout = '/tmp/private'; },
    h => { h.sources[0].checkout = '/tmp/private'; },
    h => { h.mandatory.scenarioIds = []; },
    h => { h.invocation.event = 'push'; },
    h => { h.resources = 'retained'; },
    h => { h.mode = 'fixture'; },
  ]) {
    const handoff = structuredClone(actual.handoff);
    modify(handoff);
    assert.throws(() => validateHandoff(handoff));
  }
});
test('actual workers execute through controlled gate dependencies', async () => {
  const f = fixture();
  f.dependencies.run = run;
  process.env.NIBFIN_RELEASE_TEST_SECRET = 'must-not-reach-worker';
  let actual;
  try { actual = await invoke(f); }
  finally { delete process.env.NIBFIN_RELEASE_TEST_SECRET; }
  assert.equal(actual.outcome, 'ready', actual.reason);
  assert.equal(f.state.disposed, 1);
});

test('unknown worker termination retains sources and never claims cleanup', async () => {
  const f = fixture();
  f.dependencies.run = async selected => report(selected.map(row =>
    result(row, 'failing', 'TERMINATION_ERROR', 'unsettled')));
  await blocked(f, /termination unknown/);
  assert.equal(f.state.disposed, 0);
});

for (const reason of ['missing producer', 'build failed', 'partial staging']) {
  test(`release failure blocks handoff and disposes: ${reason}`, async () => {
    const f = fixture();
    f.prepared.preflightRelease = async () => { throw new Error(reason); };
    await blocked(f, new RegExp(reason));
    assert.equal(f.state.ran, 1);
    assert.equal(f.state.disposed, 1);
  });
}
test('unknown producer termination retains staging and sources', async () => {
  const f = fixture();
  f.prepared.preflightRelease = async () => {
    throw Object.assign(new Error('producer unsettled'), { terminationUnknown: true });
  };
  await blocked(f, /producer unsettled/);
  assert.equal(f.state.disposed, 0);
});
test('serialized success cannot replace invocation or execution', async () => {
  const f = fixture();
  const prior = await invoke(f);
  const fresh = fixture();
  await blocked(fresh, /VERSION/, [prior.handoff]);
  assert.equal(fresh.state.ran, 0);
});
test('main movement during release builds prevents readiness', async () => {
  const f = fixture();
  f.prepared.preflightRelease = async () => { f.mains[0].commit = 'b'.repeat(40); };
  await blocked(f, /REMOTE_MAIN/);
  assert.equal(f.state.disposed, 1);
});
