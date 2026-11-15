import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { installationFixture } from './installation-fixture.mjs';
import { pairedFixture } from './delivery-pair-support.mjs';
import { wakeFixture } from '../scenarios/wake-fixtures.mjs';
import { sourceRepositories } from '../source-checkout.mjs';
import { catalog } from '../coverage-catalog.mjs';
import { scenarios } from '../registry.mjs';
import { createContractGate } from '../release-gate.mjs';

export async function releaseCoverageFixture(t) {
  const cli = await installationFixture(t);
  for (const source of sourceRepositories) {
    Object.assign(cli.sources[source.id], source);
    Object.assign(cli.observation.sources[source.id], {
      repository: source.repository,
    });
  }
  cli.sources.core.output.pin.repository = cli.sources.core.repository;
  await writeFile(join(cli.sources.action.checkout, 'core-source.json'),
    JSON.stringify(cli.sources.core.output.pin));
  await writeFile(join(cli.sources.cli.checkout, 'internal/cli/producers.json'),
    JSON.stringify({ core: cli.sources.core.output.pin, action: cli.sources.action }));
  const pair = pairedFixture();
  const action = wakeFixture('action');
  for (const record of [action.expected, action.evidence.action,
    action.evidence.core[0]]) {
    record.stage = 'deliver';
    record.actionRef = `${cli.sources.action.repository}@${cli.sources.action.commit}`;
  }
  const expected = { repository: 'taco3064/nibfin-e2e',
    workflow: '.github/workflows/nibfin-release.yml', environment: 'release' };
  const identity = { ...expected, authorized: true, event: 'workflow_dispatch',
    ref: 'refs/heads/main', actor: 'operator', runId: '123', attempt: '1' };
  const state = { prepared: 0, disposed: 0, staged: 0, writes: 0 };
  const prepared = { sources: cli.sources, root: cli.root, disposed: false,
    async preflightRelease() { state.staged++; },
    async dispose() {
      await rm(cli.root, { recursive: true, force: true });
      this.disposed = true;
      state.disposed++;
    } };
  let executed;
  const command = cli.context.command;
  cli.context.command = async (...args) => {
    executed = structuredClone(args[2].intent.invocation);
    return command(...args);
  };
  cli.context.observe = async () => ({ ...structuredClone(cli.observation),
    invocation: executed ? Object.fromEntries(['github', 'host'].map(channel =>
      [channel, { ...executed, origin: 'synthetic', fresh: true, terminated: true,
        effects: 'reconciled' }])) : null });
  const f = { cli, pair, action, prepared, state, identity, release: null,
    editEnvelope: () => {}, editAdapters: () => {} };
  const capabilities = { expected, verifyInvocation: async () => identity,
    native: { write: async () => { state.writes++; assert.fail('publication'); } },
    observeConflicts: async version => sourceRepositories.map(({ repository }) =>
      ({ repository, version, complete: true, tags: [], releases: [],
        activePublications: [] })),
    observeMains: async () => sourceRepositories.map(({ id, repository, ref }) =>
      ({ repository, ref, complete: true, commit: cli.sources[id].commit })),
    coverage: { open: async context => {
      assert.equal(context.prepared, prepared);
      f.release = structuredClone(context.release);
      const envelope = callback => async (...args) => {
        const record = { release: structuredClone(context.release),
          value: await callback(...args) };
        f.editEnvelope(record);
        return record;
      };
      const caller = { ...pair.caller };
      for (const key of ['readWakeEvidence', 'readDeliveryEvidence', 'observe',
        'assertSource', 'readConcurrencyEvidence', 'readIsolationEvidence']) {
        caller[key] = envelope(pair.caller[key]);
      }
      const adapters = {
        delivery: { request: { repository: 'fixture/repository',
          assignee: { id: 7, login: 'target-actor' } }, caller },
        action: { expected: action.expected,
          readEvidence: envelope(async () => action.evidence),
          observe: envelope(async target => Object.values(action.evidence).find(v =>
            JSON.stringify(v?.target) === JSON.stringify(target))) },
        cli: { inventory: cli.inventory,
          context: { ...cli.context, observe: envelope(cli.context.observe) } },
      };
      f.editAdapters(adapters);
      return adapters;
    } },
  };
  const dependencies = { catalog: structuredClone(catalog),
    registry: structuredClone(scenarios), nativeCoverage: true,
    prepare: async () => { state.prepared++; return prepared; },
    run: () => assert.fail('ordinary workers must not replace native producers') };
  return Object.assign(f, { capabilities, dependencies,
    invoke: () => createContractGate(capabilities, dependencies)(['1.2.3']) });
}
