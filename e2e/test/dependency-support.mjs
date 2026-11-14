import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { fixtureLifecycle } from '../fixture-lifecycle.mjs';
import { protectedFixture } from './delivery-support.mjs';

// Entirely synthetic provider, using the real durable ownership implementation.
export async function dependencyFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-dependency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const delivery = protectedFixture();
  const issues = new Map();
  const owned = [];
  const writes = [];
  const admissions = [];
  const nativeExecutions = new Map();
  let edge = false;
  let evidence;
  const context = { authorize: async () => true, idle: async () => true };
  const caller = { ...delivery.caller };
  caller.createFixture = async definition => {
    const downstream = definition.scenario === 'dependency-downstream';
    const number = downstream ? 30 : 29;
    const id = downstream ? 11 : 10;
    const inventory = await fixtureInventory(join(root, 'ledger'), definition, 7,
      join(root, 'worker'));
    const api = {
      preflight: async () => 7,
      beforeCreate: async () => {},
      async create(record) {
        const issue = { ...record.payload, id, number, user: { id: 7 },
          state: 'open', labels: [],
          url: `https://api.github.com/repos/${definition.repository}/issues/${number}` };
        issues.set(number, issue);
        return structuredClone(issue);
      },
      read: async record => structuredClone(issues.get(record.native.number)),
      dependencies: async () => edge ? [structuredClone(issues.get(29))] : [],
      async mutateIssue(record) {
        writes.push(record.mutation.kind);
        if (record.mutation.kind === 'add-blocked-by') edge = true;
        else issues.get(number).body = record.mutation.body;
      },
      async cleanup() {
        writes.push(`close-${number}`);
        issues.get(number).state = 'closed';
      },
    };
    const lifecycle = fixtureLifecycle({ inventory, provider: () => api, context });
    const value = { definition, inventory, lifecycle, api };
    owned.push(value);
    return value;
  };
  const read = caller.readDeliveryEvidence;
  caller.readDeliveryEvidence = async binding => {
    const value = await read(binding);
    issues.get(29).state = 'closed';
    issues.get(29).labels = [{ name: 'delivered' }];
    return value;
  };
  caller.admitDependency = async binding => {
    admissions.push(binding);
    const after = binding.phase === 'after';
    const runId = after ? 502 : 501;
    const jobId = after ? 602 : 601;
    evidence = { admission: { ...binding, authorized: true, executed: true,
      runRepository: binding.repository, runId, attempt: 1, jobId,
      invocation: `dependency-${runId}`, originEvent: 'issues',
      decision: after ? 'dispatched' : 'blocked',
      reason: after ? 'DISPATCHED' : 'NATIVE_DEPENDENCY_INCOMPLETE' } };
    const base = `https://api.github.com/repos/${binding.repository}`;
    nativeExecutions.set(runId, {
      run: { id: runId, run_attempt: 1, repository: { full_name: binding.repository },
        url: `${base}/actions/runs/${runId}`, event: 'workflow_dispatch',
        status: after ? 'in_progress' : 'completed',
        conclusion: after ? null : 'success' },
      jobs: [{ id: jobId, run_id: runId, run_attempt: 1,
        url: `${base}/actions/jobs/${jobId}`, status: after ? 'in_progress' : 'completed',
        conclusion: after ? null : 'success' }],
    });
    return structuredClone(evidence.admission);
  };
  caller.readDependencyEvidence = async () => structuredClone(evidence);
  const observe = caller.observe;
  caller.observe = async target => {
    let data;
    if (target.kind === 'issue') data = issues.get(target.number);
    else if (target.kind === 'blocking') data = edge ? [issues.get(30)] : [];
    else if (target.kind === 'blocked_by') data = edge ? [issues.get(29)] : [];
    else if (nativeExecutions.has(target.runId)) {
      data = nativeExecutions.get(target.runId)[target.kind];
    } else return observe(target);
    return { target, complete: true, data: structuredClone(data) };
  };
  return { caller, owned, issues, writes, admissions, context, nativeExecutions,
    delivery, setEdge: value => { edge = value; } };
}
