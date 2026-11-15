import { same, validEnrollment, sha } from './peer-observations.mjs';
import { matchesContinuity } from './wake-continuity.mjs';

export const sharedIdentityKeys = ['repositoryId', 'runRepositoryId', 'issueId',
  'actorId', 'checkRunId', 'workflowId', 'workflowRef', 'sourceCommit', 'ref',
  'workflowBlob', 'originActorId', 'originWorkflowId', 'originSourceCommit',
  'originWorkflowRef'];
const id = n => Number.isSafeInteger(n) && n > 0;
const oidcKeys = ['repositoryId', 'runId', 'attempt', 'actorId', 'checkRunId',
  'sourceCommit'];
const oidcOutputKeys = oidcKeys.concat(['identityHash', 'expiresAt']);

export function sharedIdentities(expected, evidence, mode) {
  const x = expected;
  const e = evidence;
  const peer = e.enrollment;
  if (!validEnrollment(peer, mode) ||
      !['repositoryId', 'runRepositoryId', 'actorId', 'checkRunId',
        'workflowId', 'originWorkflowId', 'originActorId'].every(k => id(x[k])) ||
      typeof x.issueId !== 'string' || !/^[A-Za-z0-9_=-]{1,200}$/.test(x.issueId) ||
      !sha(x.sourceCommit) || !sha(x.originSourceCommit) || !sha(x.workflowBlob) ||
      !same(peer.binding, x, ['repository', 'repositoryId', 'runRepository',
        'runRepositoryId']) ||
      x.runnerLabel !== `nibfin-user-${peer.binding.memberId}` ||
      !peer.runners.some(r => r.id === x.runnerId)) return null;
  const w = peer.callers.execution;
  const caller = peer.callers.issue;
  if (!matchesContinuity(x, e.continuity, peer) ||
      !same(w, { workflowId: x.workflowId, path: x.sharedWorkflow,
    sourceCommit: x.sourceCommit, ref: x.workflowRef, blob: x.workflowBlob },
  ['workflowId', 'path', 'ref', 'blob']) ||
      !same(caller, { workflowId: x.originWorkflowId,
        sourceCommit: x.originSourceCommit, ref: x.originWorkflowRef },
      ['workflowId', 'ref']) ||
      x.workflowRef !== `${x.runRepository}/${x.sharedWorkflow}@${x.ref}` ||
      !x.ref?.startsWith('refs/heads/') ||
      x.reusableWorkflow !== `${peer.sources.core.repository}/` +
        `.github/workflows/issue.yml@${peer.sources.core.commit}`) return null;
  const run = e.run.data;
  const origin = e.origin?.data;
  const job = e.jobs.data.find(j => j.id === x.jobId);
  if (e.issue.data.node_id !== x.issueId ||
      run.repository?.id !== x.runRepositoryId || run.actor?.id !== x.actorId ||
      run.workflow_id !== x.workflowId || run.head_sha !== x.sourceCommit ||
      `refs/heads/${run.head_branch}` !== x.ref ||
      run.event !== 'workflow_dispatch' ||
      origin?.repository?.id !== x.repositoryId ||
      origin.actor?.id !== x.originActorId || origin.workflow_id !== x.originWorkflowId ||
      origin.head_sha !== x.originSourceCommit || origin.path !== caller.path ||
      caller.ref !== `${x.repository}/${caller.path}@refs/heads/${origin.head_branch}` ||
      job.runner_name !== peer.runners.find(r => r.id === x.runnerId).name ||
      job.check_run_url !== `https://api.github.com/repos/${x.runRepository}/` +
        `check-runs/${x.checkRunId}` ||
      !same(e.wake, x, sharedIdentityKeys) ||
      !same(e.core[0], x, sharedIdentityKeys) ||
      !same(e.route, x, ['repositoryId', 'runRepositoryId', 'issueId',
        'originActorId', 'originWorkflowId', 'originSourceCommit',
        'originWorkflowRef']) ||
      !same(e.forwarding, x, ['repository', 'repositoryId', 'issue', 'issueId',
        'originRunId', 'originAttempt', 'runRepository', 'runRepositoryId',
        'runId', 'attempt', 'actorId', 'originActorId',
        'workflowId', 'workflowRef', 'sourceCommit']) ||
      e.forwarding.confirmed !== true) return null;
  const oidc = e.oidc;
  // Core has already verified this sanitized binding. Never accept raw tokens.
  if (oidc?.verified !== true || !same(oidc, {
    ...x, repositoryId: x.runRepositoryId,
  }, oidcKeys) || oidc.jobId !== x.jobId || oidc.runnerId !== x.runnerId ||
      !/^[a-f0-9]{64}$/.test(oidc.identityHash ?? '') ||
      !id(oidc.expiresAt)) return null;
  return Object.fromEntries(oidcOutputKeys.map(k => [k, oidc[k]]));
}
