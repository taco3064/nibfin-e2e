import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseEntry } from '../release-entry.mjs';

const env = {
  GITHUB_REPOSITORY: 'taco3064/nibfin-e2e',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_ACTOR: 'taco3064',
  NIBFIN_RELEASE_REF_PROTECTED: 'true',
  NIBFIN_RELEASE_CONTEXT:
    'taco3064/nibfin-e2e/.github/workflows/nibfin-release.yml@refs/heads/main',
  NIBFIN_RELEASE_VERSION: '1.2.3',
};
const approval = [{ state: 'approved', user: { login: 'taco3064' },
  environments: [{ name: 'nibfin-release' }] }];

test('release entry requires protected main and Environment approval', async () => {
  const authorize = caps => () => caps.verifyInvocation();
  const request = async () => ({ status: 200, data: approval });
  assert.equal((await releaseEntry(env, request, authorize)).authorized, true);
  for (const overrides of [
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/tags/main' },
    { NIBFIN_RELEASE_REF_PROTECTED: 'false' }, { GITHUB_RUN_ATTEMPT: '2' },
    { NIBFIN_RELEASE_CONTEXT: 'other' },
  ]) {
    const unexpected = () => assert.fail('denied context called GitHub');
    await assert.rejects(releaseEntry({ ...env, ...overrides }, unexpected, authorize),
      /AUTHORIZATION/);
  }
  const otherApproval = [{ ...approval[0], user: { login: 'other' } }];
  for (const data of [[], otherApproval]) {
    await assert.rejects(releaseEntry(env,
      async () => ({ status: 200, data }), authorize), /Environment approval/);
  }
});

test('production gate rejects an unmapped suite', async () => {
  const requests = [];
  const result = await releaseEntry(env, async url => {
    requests.push(url.pathname);
    return url.pathname.endsWith('/approvals')
      ? { status: 200, data: approval } : { status: 404, data: null };
  });
  assert.equal(result.outcome, 'blocked');
  assert.match(result.reason, /COVERAGE: mandatory release requirements are unmapped/);
  assert.equal(requests.length, 13);
});
