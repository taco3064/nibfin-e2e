import { peerFixture } from './peer-fixtures.mjs';

// Deliberately synthetic identities. This module cannot authorize protected work.
export function wakeFixture(leg = 'shared-issue', status = 'completed', target = {}) {
  const expected = { repository: target.repository ?? 'fixture/repository',
    issue: target.issue ?? 29, runRepository: 'fixture/execution',
    originRunId: 100, originAttempt: 1, runId: 200, attempt: 2, jobId: 300,
    invocation: 'invocation-1', stage: leg === 'action' ? 'not-a-stage' : 'deliver',
    status, code: status === 'denied' ? 'INVALID_STAGE_REQUEST' : 'STAGE_COMPLETED',
    reusableWorkflow: 'fixture/core/.github/workflows/issue.yml@' + 'b'.repeat(40),
    sharedWorkflow: '.github/workflows/shared-runner.yml',
    runnerId: 400, runnerLabel: 'nibfin-user-7', actionRef: 'taco3064/nibfin-act',
  };
  const enrollment = peerFixture(expected.repository);
  Object.assign(expected, { repositoryId: 11, runRepositoryId: 12,
    issueId: 'I_fixture_10', actorId: 7, originActorId: 7, checkRunId: 301,
    workflowId: 502,
    workflowRef: enrollment.callers.execution.ref, sourceCommit: 'c'.repeat(40),
    ref: 'refs/heads/main', workflowBlob: 'd'.repeat(40),
    originWorkflowId: 500, originSourceCommit: 'c'.repeat(40),
    originWorkflowRef: enrollment.callers.issue.ref });
  const root = `https://api.github.com/repos/${expected.repository}`;
  const executionRoot = `https://api.github.com/repos/${expected.runRepository}`;
  const observation = (target, data) => ({ complete: true, target, data });
  const run = (runId, attempt, repository, base) => observation({ kind: 'run',
    repository, runId, attempt }, {
    id: runId, run_attempt: attempt, url: `${base}/actions/runs/${runId}`,
    repository: { full_name: repository, id: runId === 100 ? 11 : 12 },
    actor: { id: 7 }, workflow_id: runId === 100 ? 500 : 502,
    head_sha: 'c'.repeat(40), head_branch: 'main',
    event: runId === 100 ? 'issues' : 'workflow_dispatch',
    path: runId === 100 ? enrollment.callers.issue.path : expected.sharedWorkflow,
    status: 'completed', conclusion: 'success',
  });
  const core = { ...expected, receiptHash: status === 'completed' ? 'a'.repeat(64) : '' };
  const evidence = {
    issue: observation({ kind: 'issue', repository: expected.repository,
      number: expected.issue },
    { id: 10, node_id: 'I_fixture_10', number: expected.issue,
      url: `${root}/issues/${expected.issue}` }),
    origin: run(100, 1, expected.repository, root),
    run: run(200, 2, expected.runRepository, executionRoot),
    jobs: observation({ kind: 'jobs', repository: expected.runRepository,
      runId: 200, attempt: 2 }, [{ id: 300, run_id: 200, run_attempt: 2,
      url: `${executionRoot}/actions/jobs/300`, status: 'completed',
      conclusion: 'success',
      check_run_url: `${executionRoot}/check-runs/301`,
      runner_id: 400, runner_name: 'runner-400', labels: ['nibfin-user-7'],
      steps: [{ number: 4, name: 'Native Action', status: 'completed',
        conclusion: status === 'denied' ? 'failure' : 'success' }],
    }]),
    enrollment, forwarding: { ...expected, confirmed: true },
    oidc: { verified: true, repositoryId: 12, runId: 200, attempt: 2,
      actorId: 7, checkRunId: 301, sourceCommit: 'c'.repeat(40),
      jobId: 300, runnerId: 400, identityHash: 'e'.repeat(64), expiresAt: 123456789 },
    route: { ...expected, decision: 'forwarded' }, wake: { ...expected },
    core: [core], action: { ...expected, executed: true, stepNumber: 4,
      stepName: 'Native Action', outputs: { status, code: expected.code,
        'receipt-hash': core.receiptHash } },
  };
  evidence.continuity = { state: 'satisfied', binding: { ...expected },
    sources: structuredClone(enrollment.sources),
    callers: structuredClone(enrollment.callers) };
  return { expected, evidence };
}
