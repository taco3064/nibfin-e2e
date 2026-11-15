// Synthetic observations only; never an installation or provider certificate.
export function peerFixture(repository = 'fixture/repository') {
  const sources = Object.fromEntries(['core', 'action', 'cli'].map(k => [k, {
    repository: `fixture/${k}`, commit: 'b'.repeat(40),
  }]));
  return { origin: 'synthetic', disposition: 'success', adopted: true,
    binding: { owner: 'fixture-owner', hostId: 'fixture-host', repository,
      repositoryId: 11, memberId: 7, runRepository: 'fixture/execution',
      runRepositoryId: 12 }, sources,
    runners: [400, 401].map(id => ({ id, name: `runner-${id}`,
      memberId: 7, repositoryId: 12 })),
    registrationsComplete: true, targetRunnerCount: 0,
    callers: Object.fromEntries(['issue', 'action', 'execution'].map((key, i) => {
      const paths = ['.github/workflows/nibfin-issue.yml',
        '.github/workflows/nibfin-wake.yml', '.github/workflows/shared-runner.yml'];
      const repo = key === 'execution' ? 'fixture/execution' : repository;
      return [key, { workflowId: 500 + i, path: paths[i],
        sourceCommit: 'c'.repeat(40), ref: `${repo}/${paths[i]}@refs/heads/main`,
        blob: 'd'.repeat(40) }];
    })),
  };
}
