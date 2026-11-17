import { observed, nativeExecution } from './wake-correlation.mjs';

// A controlled selection extends the native evidence path without claiming a stage.
export function correlateManagedWake(activation, evidence) {
  const result = state => ({ mode: 'fixture', state, stageAdmitted: false });
  try {
    const origin = activation.config.origins[0];
    const dest = activation.destination;
    const issue = evidence.selection.observation.issue;
    const selected = evidence.selection.observation;
    const key = { repositoryId: origin.repositoryId, runId: 30, attempt: 1 };
    const record = evidence.record;
    const artifact = evidence.artifact;
    const job = evidence.jobs.data[0];
    const run = evidence.run.data;
    const original = evidence.origin;
    const slot = activation.slots.find(item => item.id === job.runner_id);
    const binding = activation.bindings.origins[0];
    const expected = { runRepository: dest.repository, runId: record.runId,
      attempt: 1, jobId: job.id };
    const intent = record.intent;
    const envelope = JSON.parse(evidence.dispatch.inputs.wake_event);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const valid = activation.result.mode === 'managed' &&
      activation.result.dispatch_observed === false &&
      activation.slots.length === 2 &&
      binding.repositoryId === origin.repositoryId &&
      binding.event.memberId === activation.memberId &&
      binding.repository === origin.repository &&
      binding.event.workflowPath === origin.workflow.path &&
      binding.event.workflowId === origin.workflow.id &&
      binding.event.workflowBlob === origin.workflow.blob &&
      binding.event.sourceCommit === origin.workflow.commit &&
      binding.event.reusable.commit === activation.pin.commit &&
      same(record.origin, key) && record.status === 'consumed' &&
      original.id === key.runId && original.run_attempt === 1 &&
      original.repository.id === origin.repositoryId &&
      original.workflow_id === origin.workflow.id &&
      original.head_sha === origin.workflow.commit &&
      original.actor.id === activation.memberId &&
      original.triggering_actor.id === activation.memberId &&
      original.path === origin.workflow.path &&
      artifact.id === intent.source.artifactId &&
      artifact.name === evidence.producer.artifactName &&
      artifact.digest === intent.source.artifactDigest && !artifact.expired &&
      artifact.workflow_run.id === key.runId &&
      artifact.workflow_run.repository_id === origin.repositoryId &&
      artifact.workflow_run.head_sha === original.head_sha &&
      artifact.workflow_run.head_repository_id === origin.repositoryId &&
      intent.source.repository === origin.repository &&
      intent.source.coreCommit === activation.pin.commit &&
      intent.destination.repositoryId === dest.repositoryId &&
      intent.destination.repository === dest.repository &&
      nativeExecution(evidence, expected, false) &&
      run.id === record.runId && run.repository.id === dest.repositoryId &&
      run.workflow_id === intent.destination.id &&
      run.head_sha === intent.destination.commit &&
      run.path === activation.runner.workflowPath &&
      run.workflow_id === activation.runner.workflowId &&
      run.head_sha === activation.runner.sourceCommit &&
      run.actor.id === activation.memberId &&
      slot?.name === job.runner_name && slot.memberId === activation.memberId &&
      job.labels.includes(`nibfin-user-${activation.memberId}`) &&
      observed(evidence.issue, { kind: 'issue', repository: origin.repository,
        number: issue.number }) &&
      issue.repositoryId === origin.repositoryId &&
      issue.repository === origin.repository &&
      issue.id === evidence.issue.data.node_id &&
      selected.entryStage === 'shape' && selected.route.userId === activation.memberId &&
      selected.route.label === `nibfin-user-${activation.memberId}` &&
      evidence.selection.stageAdmitted === false &&
      same(intent.inputs, evidence.dispatch.inputs) &&
      envelope.runId === key.runId &&
      envelope.event.issue.node_id === issue.id &&
      envelope.event.repository.id === issue.repositoryId &&
      evidence.dispatch.inputs.issue_id === issue.id &&
      evidence.dispatch.inputs.stage === 'wake';
    return result(valid ? 'passed' : 'unverified');
  } catch { return result('unverified'); }
}
