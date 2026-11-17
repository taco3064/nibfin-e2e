import assert from 'node:assert/strict';
import { loader } from './provider.mjs';
import { correlateManagedWake } from '../../managed-wake-correlation.mjs';

export async function selectShape(context, activation, fixture) {
  const load = loader(context.sources.core);
  const { readForwardedWake } = await load('src/shared-wake.mjs');
  const { observeIssueEvent } = await load('src/issue-wake.mjs');
  const { observeWake } = await load('src/wakeup.mjs');
  const { repositoryIssuePin } = await load('src/repository-admission.mjs');
  const { origin, state } = fixture;
  const record = await fixture.journal().read(fixture.key);
  const identity = record.intent.issue;
  const forwarded = readForwardedWake(JSON.stringify(state.sent), identity);
  const reader = fixture.reader();
  await observeIssueEvent(reader, null, forwarded.event, {
    repository: origin.repository, coreCommit: activation.pin.commit,
    runId: forwarded.runId, attempt: 1, eventName: 'issues',
    shared: true, forwarded: true, managed: true,
  });
  const pin = repositoryIssuePin({ kind: 'repository-admission-v1',
    repository: origin.repository, repositoryId: origin.repositoryId,
    memberId: activation.memberId, source: {
      repository: activation.pin.repository, commit: activation.pin.commit,
      policyHash: 'a'.repeat(64), skillsHash: 'b'.repeat(64),
    } }, identity);
  const observation = await observeWake(reader, { approvalPin: pin,
    workflow: { id: origin.workflow.id, path: origin.workflow.path },
    actorId: activation.memberId, shared: true }, () => state.now);
  const destination = activation.destination.repository;
  const nativeRun = await reader.get(`/repos/${destination}/actions/runs/60`);
  const jobs = await reader.list(
    `/repos/${destination}/actions/runs/60/attempts/1/jobs`, 'jobs');
  const issue = await reader.issue(identity);
  const original = await reader.get(
    `/repos/${origin.repository}/actions/runs/30/attempts/1`);
  const artifact = await reader.get(`/repos/${origin.repository}/actions/artifacts/40`);
  const evidence = {
    producer: { artifactName: fixture.produced.artifactName },
    record, origin: original, artifact, dispatch: state.sent,
    selection: { observation, stageAdmitted: false },
    run: { complete: true, target: { kind: 'run', repository: destination,
      runId: 60, attempt: 1 }, data: nativeRun },
    jobs: { complete: true, target: { kind: 'jobs', repository: destination,
      runId: 60, attempt: 1 }, data: jobs },
    issue: { complete: true, target: { kind: 'issue', repository: origin.repository,
      number: identity.number }, data: issue },
  };
  assert.equal(correlateManagedWake(activation, evidence).state, 'passed');
  return evidence;
}
