import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { provider } from './provider.mjs';
import { selectShape } from './selection.mjs';
import { correlateManagedWake } from '../../managed-wake-correlation.mjs';

const refused = async (fixture, code, mutate) => {
  mutate(fixture.state);
  let observed;
  try { observed = (await fixture.process()).code; }
  catch (error) { observed = error.code ?? error.message; }
  assert.equal(observed, code);
  assert.equal(fixture.state.posts, 0);
  const record = await fixture.journal().read(fixture.key);
  assert.ok(!record || record.status === 'skipped');
};
const cases = [
  ['activation-to-shape', async (f, context, activation) => {
    const result = await f.process();
    assert.equal(result.status, 'consumed');
    assert.equal(result.stageAdmitted, false);
    const evidence = await selectShape(context, activation, f);
    // Each independent observation is mandatory.
    for (const field of Object.keys(evidence)) {
      const copy = structuredClone(evidence);
      delete copy[field];
      assert.equal(correlateManagedWake(activation, copy).state, 'unverified', field);
    }
    for (const path of [
      'origin.id', 'origin.run_attempt', 'origin.repository.id',
      'artifact.id', 'artifact.digest', 'artifact.workflow_run.repository_id',
      'run.data.id', 'run.data.run_attempt', 'run.data.repository.id',
      'run.data.actor.id', 'run.data.head_sha', 'run.data.workflow_id',
      'jobs.data.0.runner_id', 'jobs.data.0.runner_name',
      'jobs.data.0.run_attempt', 'issue.data.node_id',
      'selection.observation.issue.id', 'selection.observation.route.userId',
      'selection.observation.entryStage', 'selection.stageAdmitted',
      'record.runId', 'record.origin.attempt', 'dispatch.inputs.issue_id',
    ]) {
      const copy = structuredClone(evidence), keys = path.split('.');
      const field = keys.pop();
      const item = keys.reduce((value, key) => value[key], copy);
      item[field] = 'altered';
      assert.equal(correlateManagedWake(activation, copy).state, 'unverified', path);
    }
    for (const path of ['memberId', 'destination.repositoryId',
      'config.origins.0.workflow.blob', 'runner.workflowId', 'slots.0.id',
      'slots.0.memberId', 'bindings.origins.0.event.workflowId']) {
      const copy = structuredClone(activation), keys = path.split('.');
      const field = keys.pop();
      keys.reduce((value, key) => value[key], copy)[field] = 'altered';
      assert.equal(correlateManagedWake(copy, evidence).state, 'unverified', path);
    }
    assert.equal((await f.process()).code, 'RELAY_REPLAY');
    assert.equal(f.state.posts, 1);
  }],
  ['offline-before-expiry', async f => {
    f.state.offline = true;
    await assert.rejects(f.process(), /offline/);
    assert.equal(await f.journal().read(f.key), null);
    f.state.now += 3600000;
    f.state.offline = false;
    // The independently observed destination appears at resumed controlled time.
    f.state.run.created_at = new Date(f.state.now + 1000).toISOString();
    assert.equal((await f.relay().poll()).results[0].status, 'consumed');
    assert.equal(f.state.posts, 1);
    assert.equal((await f.process()).code, 'RELAY_REPLAY');
  }],
  ['lost-dispatch-reply', async f => {
    f.state.lost = true;
    assert.equal((await f.process()).status, 'pending');
    assert.equal((await f.journal().read(f.key)).runId, undefined);
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.process()).status, 'pending');
      assert.equal(f.state.run.id, 60); // A matching run exists independently.
    }
    assert.equal(f.state.posts, 1);
  }],
  ['exact-readback-recovery', async f => {
    f.state.readbackLost = true;
    assert.equal((await f.process()).status, 'pending');
    assert.equal((await f.journal().read(f.key)).runId, 60);
    f.state.readbackLost = false;
    assert.equal((await f.process()).status, 'consumed');
    assert.equal(f.state.posts, 1);
  }],
  ['wrong-exact-run', async f => {
    f.state.run.head_sha = 'c'.repeat(40);
    assert.equal((await f.process()).status, 'pending');
    assert.equal((await f.process()).status, 'pending');
    assert.equal(f.state.posts, 1);
  }],
  ['artifact-evidence-unavailable', async f => {
    f.state.artifactUnavailable = true;
    await assert.rejects(f.process(), { code: 'RELAY_HTTP_UNAVAILABLE' });
    assert.equal(await f.journal().read(f.key), null);
    assert.equal(f.state.posts, 0);
    f.state.artifactUnavailable = false;
    assert.equal((await f.process()).status, 'consumed');
  }],
  ['revoked-after-artifact', f => refused(f, 'MEMBER_PERMISSION_REVOKED', s => {
    s.afterArtifact = current => { current.permission = 'read'; };
  })],
  ['adoption-changed-after-artifact', f => refused(f,
    'simulated adoption changed', s => {
      s.afterArtifact = current => { current.adoptionChanged = true; };
    })],
  ['expired-original-with-rerun', async f => {
    f.state.artifact.expired = true;
    assert.equal((await f.process()).code, 'RELAY_ORIGINAL_EXPIRED');
    assert.equal((await f.process()).code, 'RELAY_REPLAY');
    assert.equal(f.state.posts, 0);
  }],
  ['tampered', f => refused(f, 'RELAY_ARTIFACT_DIGEST_MISMATCH', s => {
    s.artifact.digest = 'sha256:' + 'a'.repeat(64);
  })],
  ['foreign', f => refused(f, 'RELAY_ARTIFACT_OWNERSHIP_CHANGED', s => {
    s.artifact.workflow_run.repository_id++;
  })],
  ['wrong-attempt', f => refused(f, 'RELAY_ORIGINAL_EXPIRED', s => {
    s.artifact.name = 'nibfin-issue-wake-v1-2';
  })],
  ['failed-original', f => refused(f, 'RELAY_ORIGINAL_NOT_ELIGIBLE', s => {
    s.original.conclusion = 'failure';
  })],
  ['revoked-permission', f => refused(f, 'MEMBER_PERMISSION_REVOKED', s => {
    s.permission = 'read';
  })],
  ['changed-adoption', f => refused(f, 'simulated adoption changed', s => {
    s.adoptionChanged = true;
  })],
  ['changed-destination', f => refused(f, 'SHARED_DISPATCH_REPOSITORY_CHANGED', s => {
    s.destinationId++;
  })],
  ['changed-workflow', f => refused(f, 'RELAY_ORIGIN_WORKFLOW_CHANGED', s => {
    s.workflowChanged = true;
  })],
  ['closed-issue', f => refused(f, 'INACTIVE_WAKE_TARGET', s => {
    s.issue.state = 'closed';
  })],
  ['wrong-assignee', f => refused(f, 'WAKE_TARGET_NOT_READY', s => {
    s.issue.assignees = [];
  })],
  ['unresolved-dependency', f => refused(f, 'WAKE_TARGET_NOT_READY', s => {
    s.dependencies = [{ state: 'open', labels: [] }];
  })],
  ['current-state-selection', async (f, context, activation) => {
    assert.equal((await f.process()).status, 'consumed');
    f.state.issue.labels = [];
    await assert.rejects(selectShape(context, activation, f));
  }],
];
export const requiredCases = Object.freeze(cases.map(([name]) => name));
export async function exercise(context, activation) {
  const passed = [];
  for (const [name, execute] of cases) {
    const fixture = await provider(context, activation, name);
    try {
      await execute(fixture, context, activation);
      passed.push(name);
    } finally {
      // All provider effects are synthetic and awaited; no external state remains.
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
  return passed;
}
