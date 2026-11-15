import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCredentials } from '../fixture-credentials.mjs';
import { fixtureGithub } from '../fixture-github.mjs';
import { fixtureDefinition } from '../fixture-definition.mjs';
import { fixtureBudget } from '../fixture-budget.mjs';

const repository = 'taco3064/nibfin-e2e';
const sha = 'a'.repeat(40);
const privateValue = 'PRIVATE-provider-token-key-authorization';
function harness(options = {}) {
  let time = Date.parse('2026-11-15T00:00:00Z');
  let count = 0;
  const calls = [];
  const secrets = [];
  const definition = fixtureDefinition('credential-test');
  const config = {
    secretProvider: async reference => {
      secrets.push(reference);
      if (options.secretError) throw new Error(privateValue);
      return options.missing && reference === 'user-ref' ? null :
        reference === 'user-ref' ? 'USER' : 'APP';
    },
    user: { actorId: 7, ownerId: 8, repository, secretRef: 'user-ref' },
    automation: { appId: 10, installationId: 11, secretRef: 'app-ref',
      operations: ['create-branch', 'delete-branch'] },
    clock: () => time,
  };
  const repo = { id: 9, full_name: repository, owner: { id: 8, login: 'taco3064' },
    archived: false, disabled: false, permissions: { push: true } };
  async function request(token, method, url, body, missing) {
    calls.push({ token, method, url, body, missing });
    if (options.requestError) throw new Error(privateValue);
    let data;
    if (url.endsWith('/user')) data = { id: 7, type: 'User', ...options.actor };
    else if (url.endsWith('/repos/' + repository)) {
      return { status: 200, data: { ...repo, ...options.repo },
        scopes: options.scopes ?? 'repo' };
    } else if (url.endsWith('/app/installations/11')) {
      data = { id: 11, app_id: 10, account: { id: 8 }, suspended_at: null,
        permissions: { contents: 'write' }, ...options.installation };
    } else if (url.endsWith('/access_tokens')) {
      if (options.renewalError && count) throw new Error(privateValue);
      data = { token: `HELPER-${++count}`,
        expires_at: new Date(time + 3600000).toISOString(),
        permissions: { contents: 'write', metadata: 'read' }, ...options.issued };
    } else if (url.includes('/installation/repositories?')) {
      data = { total_count: 1, repositories: [repo], ...options.access };
    } else if (url.endsWith('/installation/token')) {
      if (options.revokeError) throw new Error(privateValue);
      return { status: 204 };
    } else if (url.endsWith('/installation/repositories')) {
      if (options.observationError) throw new Error(privateValue);
      return { status: options.continuedAccess ? 200 : 401 };
    } else data = { token: privateValue }; // Write responses never enter metadata.
    return { status: 200, data };
  }
  const session = fixtureCredentials(config)(request, definition);
  return { session, calls, secrets, config, definition, request,
    advance: () => { time += 3600000; } };
}
const writes = f => f.calls.filter(call => call.method !== 'GET');
async function rejectsSecretFree(action) {
  await assert.rejects(action, error => {
    assert.equal(error.message, 'Fixture credentials unavailable');
    assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error))
      .includes(privateValue));
    return true;
  });
}

test('capabilities establish User identity and scope without issuing helper tokens',
  async () => {
    const f = harness();
    const result = await f.session.capabilities();
    assert.equal(result.user.actorId, 7);
    assert.equal(result.user.ownerId, 8);
    assert.notEqual(result.user.ownerId, f.definition.owner);
    assert.equal(result.user.status, 'validated');
    assert.equal(result.automation.role, 'Installation');
    assert.equal(result.automation.status, 'not-issued');
    assert.deepEqual(writes(f), []);
    assert.deepEqual(f.secrets, ['user-ref']);
    assert.ok(!JSON.stringify(result).includes('USER'));
    assert.ok(!JSON.stringify(result).includes('user-ref'));
    result.user.operations.length = 0;
    assert.ok((await f.session.capabilities()).user.operations.length > 0);
  });

test('missing User and unverifiable identities/access block every write and issuance',
  async () => {
    for (const options of [
      { missing: true }, { secretError: true }, { requestError: true },
      { actor: { type: 'Bot' } }, { actor: { type: 'Organization' } },
      { actor: { type: undefined } }, { actor: { id: 70 } },
      { repo: { owner: { id: 80, login: 'taco3064' } } },
      { repo: { owner: { id: 8, login: 'other' } } },
      { repo: { full_name: 'other/repo' } }, { repo: { archived: true } },
      { repo: { permissions: undefined } }, { repo: { permissions: { push: false } } },
      { scopes: '' }, { scopes: 'read:org' },
    ]) {
      const f = harness(options);
      await rejectsSecretFree(() => f.session.capabilities());
      await rejectsSecretFree(() => f.session.automationBranch('create-branch', sha));
      assert.deepEqual(writes(f), [], JSON.stringify(options));
      assert.ok(!f.secrets.includes('app-ref'));
    }
    const f = harness();
    const other = fixtureCredentials(f.config)(async () => assert.fail('request'),
      fixtureDefinition('other', 'other/repo'));
    await rejectsSecretFree(() => other.capabilities());
  });

test('installation identity and grant are checked before helper issuance', async () => {
  for (const installation of [
    { id: 99 }, { app_id: 99 }, { account: { id: 99 } },
    { suspended_at: '2026-11-15T00:00:00Z' }, { suspended_at: undefined },
    { permissions: {} }, { permissions: { contents: 'read' } },
  ]) {
    const f = harness({ installation });
    await rejectsSecretFree(() => f.session.automationBranch('create-branch', sha));
    assert.deepEqual(writes(f), []);
  }
});

test('helper issuance narrows repository and permissions; App never authors User work',
  async () => {
    const f = harness();
    const result = await f.session.automationBranch('create-branch', sha);
    assert.deepEqual(writes(f)[0].body,
      { repository_ids: [9], permissions: { contents: 'write' } });
    assert.equal(writes(f)[0].token, 'APP');
    assert.equal(writes(f)[1].token, 'HELPER-1');
    assert.equal(result.automation.status, 'usable');
    assert.ok(!JSON.stringify(result).includes('HELPER'));
    await f.session.userRequest('POST', 'https://api.github.com/repos/' +
      repository + '/issues', { title: 'fixture' });
    assert.equal(writes(f).at(-1).token, 'USER');
    const before = f.calls.length;
    await rejectsSecretFree(() => f.session.automationBranch('create-issue', sha));
    assert.equal(f.calls.length, before);
  });

test('wrong helper scope, access and expiration block mutation', async () => {
  for (const options of [
    { issued: { expires_at: 'invalid' } },
    { issued: { expires_at: '2026-11-15T00:00:00Z' } },
    { issued: { permissions: { contents: 'read' } } },
    { issued: { permissions: { contents: 'write', issues: 'write' } } },
    { access: { total_count: 2 } }, { access: { repositories: [] } },
    { access: { repositories: [{ id: 99, full_name: repository }] } },
    { access: { repositories: [{ id: 9, full_name: 'other/repo' }] } },
    { access: { repositories: [
      { id: 9, full_name: repository, owner: { id: 99 } },
    ] } },
  ]) {
    const f = harness(options);
    await rejectsSecretFree(() => f.session.automationBranch('create-branch', sha));
    assert.equal(writes(f).length, 1);
    await rejectsSecretFree(() => f.session.automationBranch('delete-branch'));
    assert.equal(writes(f).length, 1);
    // Even a rejected issued token remains a cleanup obligation.
    assert.equal((await f.session.revoke()).verified, 1);
  }
});

test('expiry obtains a validated replacement with identical scope and role', async () => {
  const f = harness();
  await f.session.automationBranch('create-branch', sha);
  f.advance();
  assert.equal((await f.session.capabilities()).automation.status, 'expired');
  await f.session.automationBranch('delete-branch');
  const issuance = writes(f).filter(call => call.url.endsWith('/access_tokens'));
  assert.equal(issuance.length, 2);
  assert.deepEqual(issuance[0].body, issuance[1].body);
  assert.equal(writes(f).at(-1).token, 'HELPER-2');
  assert.deepEqual(await f.session.revoke(),
    { status: 'revoked', requested: 2, verified: 2 });
  assert.deepEqual(writes(f).filter(call => call.url.endsWith('/installation/token'))
    .map(call => call.token), ['HELPER-1', 'HELPER-2']);
});

test('failed renewal blocks expired writes and retains unknown issuance evidence',
  async () => {
    const f = harness({ renewalError: true });
    await f.session.automationBranch('create-branch', sha);
    f.advance();
    await rejectsSecretFree(() => f.session.automationBranch('delete-branch'));
    assert.ok(!writes(f).some(call => call.method === 'DELETE'));
    const count = f.calls.length;
    await rejectsSecretFree(() => f.session.automationBranch('delete-branch'));
    assert.equal(f.calls.length, count);
    assert.equal((await f.session.revoke()).status, 'unverified');
  });

test('revocation requires requested deletion and independent observed loss of access',
  async () => {
    for (const options of [{}, { continuedAccess: true }, { observationError: true },
      { revokeError: true }]) {
      const f = harness(options);
      await f.session.automationBranch('create-branch', sha);
      const result = await f.session.revoke();
      assert.equal(result.status, Object.keys(options).length ? 'unverified' : 'revoked');
      assert.equal(f.calls.at(-2).method, 'DELETE');
      assert.equal(f.calls.at(-1).method, 'GET');
      assert.equal(f.calls.at(-1).token, 'HELPER-1');
      const count = f.calls.length;
      await rejectsSecretFree(() => f.session.automationBranch('delete-branch'));
      assert.equal(f.calls.length, count);
      assert.ok(!JSON.stringify(result).includes('HELPER'));
    }
  });

test('native adapter cannot write with missing User or leak provider diagnostics',
  async () => {
    for (const secretProvider of [async () => null,
      async () => { throw new Error(privateValue); }, async () => 'USER']) {
      const f = harness();
      let requests = 0;
      const provider = fixtureGithub({ ...f.config, secretProvider,
        fetcher: async () => { requests++; throw new Error(privateValue); } });
      const adapter = provider(fixtureBudget(), f.definition);
      await rejectsSecretFree(() => adapter.create({ kind: 'issue', payload: {} }));
      assert.ok(requests <= 1);
    }
  });


test('native capability bootstrap is bounded even when the secret provider stalls',
  async () => {
    const f = harness();
    const provider = fixtureGithub({ ...f.config,
      secretProvider: () => new Promise(() => {}),
      fetcher: async () => assert.fail('No HTTP without User credential'),
    });
    const adapter = provider(fixtureBudget({ requestTimeoutMs: 5 }), f.definition);
    await rejectsSecretFree(() => adapter.capabilities());
  });


test('native transport composes bounded installation issuance, use and revocation',
  async () => {
    const f = harness();
    const provider = fixtureGithub({ ...f.config, fetcher: async (url, init) => {
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      const result = await f.request(init.headers.authorization.slice(7),
        init.method, url, init.body ? JSON.parse(init.body) : undefined);
      return { status: result.status,
        headers: { get: key => key === 'x-oauth-scopes' ? result.scopes : null },
        json: async () => result.data,
      };
    } });
    const adapter = provider(fixtureBudget(), f.definition);
    assert.equal((await adapter.capabilities()).automation.status, 'not-issued');
    await adapter.automationBranch('create-branch', sha);
    assert.equal(writes(f).at(-1).token, 'HELPER-1');
    assert.equal((await adapter.revokeAutomation()).status, 'revoked');
    await rejectsSecretFree(() => adapter.automationBranch('delete-branch'));
  });
