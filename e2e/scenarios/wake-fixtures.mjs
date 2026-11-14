// Deliberately synthetic identities. This module cannot authorize protected work.
export function wakeFixture(leg = 'shared-issue', status = 'completed', target = {}) {
  const expected = { repository: target.repository ?? 'fixture/repository',
    issue: target.issue ?? 29, runRepository: 'fixture/execution',
    originRunId: 100, originAttempt: 1, runId: 200, attempt: 2, jobId: 300,
    invocation: 'invocation-1', stage: leg === 'action' ? 'not-a-stage' : 'deliver',
    status, code: status === 'denied' ? 'INVALID_STAGE_REQUEST' : 'STAGE_COMPLETED',
    reusableWorkflow: 'taco3064/nibfin-core/.github/workflows/issue.yml@main',
    sharedWorkflow: '.github/workflows/shared-runner.yml',
    runnerId: 400, runnerLabel: 'nibfin-user-7', actionRef: 'taco3064/nibfin-act',
  };
  const root = `https://api.github.com/repos/${expected.repository}`;
  const executionRoot = `https://api.github.com/repos/${expected.runRepository}`;
  const observation = (target, data) => ({ complete: true, target, data });
  const run = (runId, attempt, repository, base) => observation({ kind: 'run',
    repository, runId, attempt }, {
    id: runId, run_attempt: attempt, url: `${base}/actions/runs/${runId}`,
    repository: { full_name: repository }, event: 'issues',
    path: expected.sharedWorkflow, status: 'completed', conclusion: 'success',
  });
  const core = { ...expected, receiptHash: status === 'completed' ? 'a'.repeat(64) : '' };
  const evidence = {
    issue: observation({ kind: 'issue', repository: expected.repository,
      number: expected.issue },
    { id: 10, number: expected.issue, url: `${root}/issues/${expected.issue}` }),
    origin: run(100, 1, expected.repository, root),
    run: run(200, 2, expected.runRepository, executionRoot),
    jobs: observation({ kind: 'jobs', repository: expected.runRepository,
      runId: 200, attempt: 2 }, [{ id: 300, run_id: 200, run_attempt: 2,
      url: `${executionRoot}/actions/jobs/300`, status: 'completed',
      conclusion: 'success',
      runner_id: 400, labels: ['nibfin-user-7'],
      steps: [{ number: 4, name: 'Native Action', status: 'completed',
        conclusion: status === 'denied' ? 'failure' : 'success' }],
    }]),
    route: { ...expected, decision: 'forwarded' }, wake: { ...expected },
    core: [core], action: { ...expected, executed: true, stepNumber: 4,
      stepName: 'Native Action', outputs: { status, code: expected.code,
        'receipt-hash': core.receiptHash } },
  };
  return { expected, evidence };
}
