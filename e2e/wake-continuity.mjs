import { pathToFileURL } from 'node:url';
import { producerFile } from './source-producers.mjs';
import { same, sha, validEnrollment } from './peer-observations.mjs';

const keys = ['repository', 'repositoryId', 'runRepository', 'runRepositoryId',
  'issueId', 'originRunId', 'originAttempt', 'runId', 'attempt', 'jobId',
  'runnerId', 'workflowId', 'workflowRef', 'workflowBlob', 'sourceCommit',
  'originWorkflowId', 'originWorkflowRef', 'originSourceCommit'];
const sourceKeys = ['core', 'action', 'cli'];

// A protected reader supplies this observation. It is never a caller claim or a
// source selector. Enrollment is the immutable admission snapshot for this job.
export function matchesContinuity(expected, observed, enrollment) {
  return observed?.state === 'satisfied' && same(observed.binding, expected, keys) &&
    sourceKeys.every(key => same(observed.sources?.[key], enrollment.sources[key],
      ['repository', 'commit'])) && ['issue', 'execution'].every(key =>
      same(observed.callers?.[key], enrollment.callers[key],
        ['workflowId', 'path', 'sourceCommit', 'ref', 'blob']));
}

// Use the prepared producer's rules, including native history and active workflow
// identity. The protected owner supplies request and workflow node identities.
// No raw response, token, diagnostics or executable current-main code is returned.
export async function readWakeContinuity({ sources, expected, enrollment,
  workflows, request, token }) {
  const unavailable = { state: 'unverified' };
  try {
    if (!validEnrollment(enrollment, 'live') ||
        !sourceKeys.every(key => same(sources[key], enrollment.sources[key],
          ['repository', 'commit']))) return unavailable;
    const file = await producerFile(sources.core.checkout, 'src/shared-caller-query.mjs');
    const { readSharedCaller } = await import(pathToFileURL(file).href);
    for (const key of ['issue', 'execution']) {
      const caller = enrollment.callers[key];
      const execution = key === 'execution';
      const repository = execution ? expected.runRepository : expected.repository;
      const workflowId = execution ? expected.workflowId : expected.originWorkflowId;
      const commit = execution ? expected.sourceCommit : expected.originSourceCommit;
      if (caller.workflowId !== workflowId || !sha(commit) ||
          (execution && caller.blob !== expected.workflowBlob)) return unavailable;
      // Both the original approval and the actual execution revision must remain
      // continuous. Checking only execution could revive replaced approval.
      for (const sourceAnchor of new Set([caller.sourceCommit, commit])) {
        const observed = await readSharedCaller({ repository, sourceAnchor,
          workflowId, workflowPath: caller.path, workflowBlob: caller.blob },
        workflows[key], token, request);
        if (!observed || observed.workflow?.state !== 'active' ||
            observed.workflow.id !== workflowId ||
            observed.workflow.path !== caller.path ||
            observed.repository?.id !== (execution ? expected.runRepositoryId :
              expected.repositoryId)) return unavailable;
      }
    }
    return { state: 'satisfied',
      binding: Object.fromEntries(keys.map(key => [key, expected[key]])),
      sources: structuredClone(enrollment.sources),
      callers: structuredClone(enrollment.callers) };
  } catch { return unavailable; }
}
