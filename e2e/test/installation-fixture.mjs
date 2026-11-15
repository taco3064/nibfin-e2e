import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { repositoryDefinition } from '../repository-definition.mjs';
import { protectedSharedInstallation } from '../runner-live.mjs';

export async function installationFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'installation88-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = repositoryDefinition({ id: 9, login: 'member' }, 'owner/e2e');
  const inventory = await fixtureInventory(join(root, 'inventory'), definition,
    9, join(root, 'worker'));
  const repositories = definition.repositories.map((repository, index) => ({
    repository, marker: definition.marker, account: definition.account,
    creation: 'settled', seed: 'settled', native: { id: index + 7,
      fullName: repository, owner: definition.account, defaultBranch: 'main' },
  }));
  await inventory.exclusive(async (state, save) => {
    state.repositories = repositories;
    await save();
  });
  const binding = { owner: definition.owner, hostId: 'disposable-linux-1',
    repository: repositories[0].repository, repositoryId: 7, memberId: 9 };
  const sources = Object.fromEntries(['core', 'action', 'cli'].map((key, index) =>
    [key, { repository: `example/${key}`, commit: String(index + 1).repeat(40),
      checkout: join(root, key), output: {} }]));
  sources.core.output.pin = { repository: sources.core.repository,
    commit: sources.core.commit, archiveHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64) };
  sources.cli.output.entry = join(root, 'cli', 'gh-nibfin');
  await mkdir(join(sources.cli.checkout, 'internal', 'cli'), { recursive: true });
  await mkdir(sources.action.checkout);
  await writeFile(join(sources.action.checkout, 'core-source.json'),
    JSON.stringify(sources.core.output.pin));
  await writeFile(join(sources.cli.checkout, 'internal/cli/producers.json'),
    JSON.stringify({ core: sources.core.output.pin, action: sources.action }));
  const identities = Object.fromEntries(Object.entries(sources).map(([key, value]) =>
    [key, { repository: value.repository, commit: value.commit }]));
  const endpoint = `https://github.com/${binding.repository}`;
  const runner = id => ({ id, name: `shared-${id}`, memberId: 9,
    repositoryId: 7, endpoint, localId: id, localName: `shared-${id}`,
    shared: true, status: 'online' });
  const observation = { binding: structuredClone(binding), sources: identities,
    installation: { pullRequest: { number: 1, headCommit: 'c'.repeat(40),
      repositoryId: 7 }, checks: 'passed', reviewed: true,
    merged: true, contentMatches: true }, host: { ready: true,
      serviceUser: 'nibfin-runner', serviceState: 'inactive' },
    endpoint, registrationsComplete: true, runners: [] };
  const commands = [];
  const authorizations = [];
  const context = { origin: 'synthetic', binding,
    credentials: { capabilities: async () => ({ user: { status: 'validated',
      role: 'User', actorId: 9, ownerId: 9, repository: binding.repository } }) },
    authorize: async request => {
      authorizations.push(request.operation);
      return request.operation !== options.denied;
    },
    observe: async () => structuredClone(observation),
    reconcile: async () => ({ terminated: true, effects: 'reconciled' }),
    command: async (file, args, settings) => {
      commands.push({ file, args, settings });
      assert.equal(file, sources.cli.output.entry);
      assert.deepEqual(args, ['init', '--repo', binding.repository,
        '--apply', '--start-shared-services']);
      assert.equal(settings.stdin, 'ignore');
      assert(settings.signal instanceof AbortSignal);
      assert(settings.timeoutMs > 0 && settings.limit === 1024 * 1024);
      observation.runners = [runner(41), runner(42)];
      observation.host.serviceState = 'active';
      return { exitCode: 2, terminated: true, stdout: JSON.stringify({
        status: 'pending', code: 'SHARED_PROTECTED_EXECUTION_UNVERIFIED',
        shared_runners: observation.runners, diagnostic: 'secret',
      }), stderr: 'secret' };
    },
  };
  const fixture = { inventory, sources, context, observation, commands,
    authorizations, runner, root, binding };
  fixture.driver = bounds => protectedSharedInstallation({ inventory, sources,
    context, bounds });
  fixture.change = action => inventory.exclusive(async (state, save) => {
    await action(state);
    await save();
  });
  fixture.read = () => inventory.exclusive(state => structuredClone(state));
  return fixture;
}
