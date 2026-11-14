import { pathToFileURL } from 'node:url';
import { githubTransport } from './github-transport.mjs';
import { createReleaseGate } from './release-gate.mjs';
import { sourceRepositories } from './source-checkout.mjs';

const expected = Object.freeze({
  repository: 'taco3064/nibfin-e2e',
  workflow: '.github/workflows/nibfin-release.yml',
  environment: 'nibfin-release',
});
const ref = 'refs/heads/main';
const workflowRef = `${expected.repository}/${expected.workflow}@${ref}`;

export function releaseEntry(env, request, gate = createReleaseGate) {
  const read = async (path, { missing = false } = {}) => {
    const result = await request(new URL(path, 'https://api.github.com'), {
      signal: AbortSignal.timeout(15_000),
    });
    if (missing && result.status === 404) return false;
    if (result.status !== 200 || result.data === null) {
      throw new Error(`GITHUB_READ: unexpected status ${result.status}`);
    }
    return result.data;
  };
  const preflight = gate({
    expected,
    verifyInvocation: async () => {
      const runId = env.GITHUB_RUN_ID;
      const attempt = env.GITHUB_RUN_ATTEMPT;
      if (env.GITHUB_REPOSITORY !== expected.repository ||
          env.NIBFIN_RELEASE_CONTEXT !== workflowRef ||
          env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
          env.GITHUB_REF !== ref || env.NIBFIN_RELEASE_REF_PROTECTED !== 'true' ||
          !/^[1-9]\d*$/.test(runId ?? '') || attempt !== '1') {
        throw new Error('AUTHORIZATION: protected main dispatch required');
      }
      const runPath = `/repos/${expected.repository}/actions/runs/${runId}`;
      const reviews = await read(`${runPath}/approvals`);
      const latest = reviews.find(review => review.environments?.some(
        environment => environment.name === expected.environment,
      ));
      if (latest?.state !== 'approved' || latest.user?.login !== 'taco3064') {
        throw new Error('AUTHORIZATION: release Environment approval required');
      }
      return { ...expected, authorized: true, event: env.GITHUB_EVENT_NAME, ref,
        actor: env.GITHUB_ACTOR, runId, attempt };
    },
    observeMains: () => Promise.all(sourceRepositories.map(async source => {
      const branch = await read(`/repos/${source.repository}/git/ref/heads/main`);
      return { repository: source.repository, complete: true,
        ref: branch.ref, commit: branch.object?.sha };
    })),
    // The workflow's single concurrency group serializes releases across versions.
    observeConflicts: version => Promise.all(sourceRepositories.map(async source => {
      const tags = [], releases = [];
      for (const name of [version, `v${version}`]) {
        const tag = encodeURIComponent(name);
        const root = `/repos/${source.repository}`;
        if (await read(`${root}/git/ref/tags/${tag}`, { missing: true })) tags.push(name);
        if (await read(`${root}/releases/tags/${tag}`, { missing: true }))
          releases.push(name);
      }
      return { repository: source.repository, version, complete: true, tags, releases,
        activePublications: [] };
    })),
  });
  return preflight([env.NIBFIN_RELEASE_VERSION]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await releaseEntry(process.env, githubTransport({
    token: process.env.GH_TOKEN,
  }));
  if (result.outcome === 'blocked') {
    console.error(result.reason);
    process.exitCode = 1;
  } else {
    console.error('PUBLICATION_UNAVAILABLE: protected coordinator hookup is pending');
    process.exitCode = 1;
  }
}
