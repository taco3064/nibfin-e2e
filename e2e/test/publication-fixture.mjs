import assert from 'node:assert/strict';
import { sourceRepositories } from '../source-checkout.mjs';
import { report, result } from '../schema.mjs';
import { digest } from '../publication-content.mjs';
import { createContractCoordinator } from '../publication-coordinator.mjs';

export function publicationFixture() {
  const expected = { repository: 'taco3064/nibfin-e2e',
    workflow: '.github/workflows/release.yml', environment: 'release' };
  const identity = { ...expected, authorized: true, event: 'workflow_dispatch',
    ref: 'refs/heads/main', actor: 'operator', runId: '123', attempt: '1' };
  const sources = Object.fromEntries(sourceRepositories.map(source => [source.id,
    { ...source, commit: 'a'.repeat(40), checkout: '/private', output: {} }]));
  const state = { record: null, writes: [], reads: [], objects: new Map(),
    fail: null, ambiguous: false, absentAfterWrite: false, disposed: false,
    conditions: true, saves: 0, preflight: 0, executions: 0 };
  const registry = ['core', 'action', 'cli'].map(id => ({
    id: `${id}.live`, group: 'release', title: `${id} controlled`, timeoutMs: 1000,
    module: new URL('./fixtures/release.mjs', import.meta.url).href,
  }));
  const dependencies = {
    registry,
    catalog: registry.map((row, index) => ({ id: row.id,
      product: ['Core', 'Action', 'CLI'][index], category: 'release',
      scenarioIds: [row.id] })),
    prepare: async () => ({ sources, disposed: false,
      async preflightRelease() { state.preflight++; },
      async dispose() { this.disposed = true; state.disposed = true; } }),
    run: async selected => {
      state.executions++;
      return report(selected.map(row => result(row, 'passed', 'PASS', 'controlled')));
    },
    capture: async ({ handoff, prepared }) => {
      assert.equal(prepared.disposed, false);
      assert.equal(state.preflight, 1);
      const bytes = Buffer.from('validated asset');
      return { handoff, repositories: handoff.sources.map(source => ({
        ...source, target: source.commit, objects: [], assets: [{ name: 'asset',
          content: bytes.toString('base64'), sha256: digest(bytes) }],
      })) };
    },
  };
  const key = context => `${context.repository.id}/${context.operation.key}`;
  const capabilities = { expected, verifyInvocation: async () => identity,
    observeMains: async () => sourceRepositories.map(row => ({ ...row,
      complete: true, commit: 'a'.repeat(40) })),
    observeConflicts: async version => sourceRepositories.map(row => ({
      repository: row.repository, version, complete: true, tags: [], releases: [],
      activePublications: [],
    })),
    verifyConditions: async () => state.conditions,
    evidence: {
      load: async () => structuredClone(state.record),
      save: async record => { state.record = structuredClone(record); state.saves++; },
    },
    native: {
      observe: async context => {
        const name = key(context);
        state.reads.push(name);
        return state.objects.has(name) ? structuredClone(state.objects.get(name)) :
          { state: 'absent' };
      },
      write: async context => {
        const name = key(context);
        assert.equal(state.record.operations[name].state, 'intent');
        state.writes.push(name);
        if (state.fail === name) throw new Error('private transport diagnostics');
        if (!state.absentAfterWrite) {
          state.objects.set(name, { state: 'matching', object: { id: name } });
        }
        if (state.ambiguous) throw new Error('lost response');
      },
    },
  };
  return { state, identity, dependencies, capabilities,
    invoke: (options = {}) => createContractCoordinator(capabilities, dependencies)(
      ['1.2.3'], options,
    ) };
}
