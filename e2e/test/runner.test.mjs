import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRunnerCommand, protectedRunnerScenarios } from '../runner-live.mjs';
import { verifyRunnerContract } from '../runner-observations.mjs';

const source = { cli: { repository: 'taco3064/gh-nibfin',
  commit: 'a'.repeat(40), output: { entry: '/protected/prepared/gh-nibfin' } } };

test('command streams retain previews, preflight and status without diagnostics', () => {
  const value = decodeRunnerCommand({ exitCode: 2, stderr: 'secret', stdout:
    '{"status":"preview","diagnostic":"secret"}\n' +
    JSON.stringify({ protected_execution: 'unverified', checks: [{ name: 'gh',
      status: 'unverified', code: 'TOOL_UNAVAILABLE' }] }, null, 2) });
  assert.equal(value.exit, 2);
  assert.equal(value.results.length, 2);
  assert.equal(value.results[1].protected_execution, 'unverified');
  assert(!JSON.stringify(value).includes('secret'));
  assert.deepEqual(decodeRunnerCommand({ exitCode: 1, stdout: '' }),
    { exit: 1, results: [] });
  for (const stdout of ['{"status":', 'noise', '{} trailing', '[{}]']) {
    assert.throws(() => decodeRunnerCommand({ exitCode: 0, stdout }));
  }
  assert.throws(() => decodeRunnerCommand({ exitCode: null, stdout: '{}' }));
  assert.equal(verifyRunnerContract({ evidence: 'live' }), false);
  assert.equal(verifyRunnerContract({ evidence: 'controlled', cases: [] }), false);
});

function protectedFixture(options = {}) {
  const state = {};
  const operations = [];
  const commands = [];
  let nativePresent = false;
  let localPresent = false;
  const target = { repository: 'example/project', repositoryId: 7, actor: 9 };
  const resource = { directory: '/owned/allocation/runner', name: 'owned-runner' };
  const native = { id: 42, name: resource.name, status: 'offline', busy: false,
    labels: [{ name: 'nibfin-user-9' }] };
  const context = {
    target,
    exclusive: action => action(state, async () => {}),
    authorize: async request => {
      operations.push(request);
      return !options.denied;
    },
    allocate: async () => structuredClone(resource),
    idle: async () => !options.active,
    receipt: async () => ({ createdByThisExecution: !options.copied,
      runnerId: 42 }),
    inspect: async () => ({ ...target, memberId: 9, runnerId: 42,
      serviceManaged: options.service === true, active: options.active === true,
      repository: target.repository, repositoryId: target.repositoryId,
      remoteAbsent: !nativePresent, localConfiguration: localPresent,
      native: nativePresent ? { ...native, busy: options.busy === true } : null,
      local: localPresent ? { agentId: 42, agentName: resource.name,
        gitHubUrl: 'https://github.com/example/project' } : null }),
    command: async (entry, args) => {
      commands.push(args);
      assert.equal(entry, source.cli.output.entry);
      const command = args[1];
      if (options.lost && command === 'register') throw new Error('secret');
      if (command === 'register') nativePresent = localPresent = true;
      if (command === 'remove') nativePresent = false;
      if (command === 'unregister') nativePresent = localPresent = false;
      return { exitCode: 0, stdout: JSON.stringify({ status: 'completed', record: {
        runner_id: 42, state: command === 'remove' ?
          'remote-removed-local-config-retained' :
          command === 'unregister' ? 'created' : 'registered',
      } }) };
    },
  };
  const scenario = protectedRunnerScenarios({ sources: source, context });
  return { scenario, state, operations, commands };
}

test('protected lifecycle separates remote removal from local unregister', async () => {
  const fixture = protectedFixture();
  assert.equal((await fixture.scenario.setup()).state, 'registered');
  const removed = await fixture.scenario.cleanup({ remoteOnly: true });
  assert.equal(removed.state, 'remote-removed-local-config-retained');
  assert.equal(removed.observations.at(-1).localConfiguration, true);
  const cleaned = await fixture.scenario.cleanup();
  assert.equal(cleaned.state, 'created');
  assert.equal(cleaned.observations.at(-1).localConfiguration, false);
  assert.equal(cleaned.evidence, 'live');
  assert.equal(cleaned.protectedExecution, 'unverified');
  assert(fixture.operations.every(request => request.actor === 9 &&
    request.repository === 'example/project'));
});

for (const condition of ['denied', 'copied', 'active', 'service', 'busy', 'lost']) {
  test(`${condition} cannot authorize or repeat destructive cleanup`, async () => {
    const fixture = protectedFixture({ [condition]: true });
    await fixture.scenario.setup();
    const before = fixture.commands.length;
    const result = await fixture.scenario.cleanup();
    assert.equal(fixture.commands.length, before);
    assert.equal(result.reason, 'RUNNER_EXECUTION_INCOMPLETE_INSPECT_BEFORE_RETRY');
    assert(!JSON.stringify(result).includes('secret'));
    if (condition === 'lost') {
      await fixture.scenario.setup();
      assert.equal(fixture.commands.length, before);
      assert.equal(fixture.state.phase, 'register-pending');
    }
  });
}

test('workers cannot obtain protected capabilities from scenario input', () => {
  assert.throws(() => protectedRunnerScenarios({ sources: source,
    context: { target: { actor: 9 }, apply: true } }),
  /PROTECTED_RUNNER_CONTEXT_REQUIRED/);
});
