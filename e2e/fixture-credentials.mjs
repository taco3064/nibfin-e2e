// Trusted composition only: configuration and providers must never come from fixtures.
const api = 'https://api.github.com';
const userOperations = Object.freeze(['create-issue', 'close-issue', 'create-pull',
  'close-pull', 'create-branch', 'delete-branch', 'edit-issue-body',
  'add-issue-label', 'remove-issue-label', 'add-blocked-by']);
const validId = value => Number.isSafeInteger(value) && value > 0;
const fail = () => { throw new Error('Fixture credentials unavailable'); };
const clone = value => structuredClone(value);

export function fixtureCredentials({
  secretProvider, user, automation, clock = Date.now,
}) {
  // Copy only configuration, never provider-returned secrets or errors into metadata.
  let config;
  try { config = clone({ user, automation }); } catch { fail(); }
  const u = config.user;
  const a = config.automation;
  if (typeof secretProvider !== 'function' || typeof clock !== 'function' ||
      !validId(u?.actorId) || !validId(u?.ownerId) ||
      !/^[\w.-]+\/[\w.-]+$/.test(u?.repository ?? '') ||
      typeof u?.secretRef !== 'string' || !u.secretRef) fail();
  if (a && (!validId(a.installationId) || !validId(a.appId) ||
      typeof a.secretRef !== 'string' || !a.secretRef ||
      !Array.isArray(a.operations) || !a.operations.length ||
      new Set(a.operations).size !== a.operations.length ||
      !a.operations.every(op => ['create-branch', 'delete-branch'].includes(op)))) fail();

  return function credentialSession(request, definition) {
    let userToken;
    let validated = false;
    let helper;
    let terminal = false;
    let busy = false;
    const helpers = [];
    let lifecycle = 'not-issued';
    let issuanceUnknown = false;
    const target = `${api}/repos/${u.repository}`;
    const now = () => {
      const value = clock();
      if (!Number.isFinite(value)) fail();
      return value;
    };
    async function secret(reference) {
      const value = await secretProvider(reference);
      if (typeof value !== 'string' || !value) fail();
      return value;
    }
    async function guarded(action) {
      if (busy) fail();
      busy = true;
      try { return await action(); } catch { fail(); } finally { busy = false; }
    }
    async function validateUser() {
      validated = false;
      if (definition.repository !== u.repository) fail();
      userToken = await secret(u.secretRef);
      const actor = await request(userToken, 'GET', `${api}/user`);
      if (actor.data?.type !== 'User' || actor.data.id !== u.actorId) fail();
      const repo = await request(userToken, 'GET', target);
      const data = repo.data;
      const scopes = (repo.scopes ?? '').split(/[, ]+/);
      if (data?.full_name !== u.repository || !validId(data.id) ||
          data.owner?.id !== u.ownerId ||
          data.owner?.login?.toLowerCase() !== u.repository.split('/')[0].toLowerCase() ||
          data.archived !== false || data.disabled !== false ||
          data.permissions?.push !== true ||
          !(scopes.includes('repo') ||
            (data.private === false && scopes.includes('public_repo')))) fail();
      validated = true;
      return data.id;
    }
    async function issue() {
      if (!a || terminal) fail();
      // Resolve and validate User first, including before helper issuance/renewal.
      const repositoryId = await validateUser();
      const bootstrap = await secret(a.secretRef);
      const installation = (await request(bootstrap, 'GET',
        `${api}/app/installations/${a.installationId}`)).data;
      if (installation?.id !== a.installationId || installation.app_id !== a.appId ||
          installation.account?.id !== u.ownerId || installation.suspended_at !== null ||
          installation.permissions?.contents !== 'write') fail();
      issuanceUnknown = true;
      const issued = (await request(bootstrap, 'POST',
        `${api}/app/installations/${a.installationId}/access_tokens`,
        { repository_ids: [repositoryId], permissions: { contents: 'write' } })).data;
      if (typeof issued?.token !== 'string' || !issued.token) fail();
      const candidate = { token: issued.token, expiresAt: Date.parse(issued.expires_at),
        state: 'unverified' };
      helpers.push(candidate);
      issuanceUnknown = false;
      lifecycle = 'unverified';
      const permissions = issued.permissions;
      if (!Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= now() ||
          permissions?.contents !== 'write' ||
          Object.entries(permissions).some(([key, value]) =>
            key !== 'contents' && !(key === 'metadata' && value === 'read'))) fail();
      const access = await request(candidate.token, 'GET',
        `${api}/installation/repositories?per_page=100`);
      if (access.link?.includes('rel="next"') || access.data?.total_count !== 1 ||
          access.data.repositories?.length !== 1 ||
          access.data.repositories[0].id !== repositoryId ||
          access.data.repositories[0].full_name !== u.repository ||
          access.data.repositories[0].owner?.id !== u.ownerId) fail();
      candidate.state = 'usable';
      helper = candidate;
      lifecycle = 'usable';
    }
    function metadata() {
      return { user: { reference: 'adopted-user', role: 'User',
        actorId: u.actorId, ownerId: u.ownerId, repository: u.repository,
        operations: validated ? [...userOperations] : [],
        scope: 'repository', status: validated ? 'validated' : 'unverified' },
      automation: a ? { reference: 'run-installation', role: 'Installation',
        installationId: a.installationId, appId: a.appId, ownerId: u.ownerId,
        repository: u.repository, permissions: { contents: 'write' },
        operations: [...a.operations], status: !terminal && helper?.state === 'usable' &&
          helper.expiresAt <= now() ? 'expired' : lifecycle,
        expiresAt: helper ? new Date(helper.expiresAt).toISOString() : null } : null };
    }
    return {
      capabilities: () => guarded(async () => {
        await validateUser();
        return metadata();
      }),
      userRequest: (method, url, body, missing) => guarded(async () => {
        if (!validated) await validateUser();
        if (!userToken || definition.repository !== u.repository) fail();
        return request(userToken, method, url, body, missing);
      }),
      automationBranch: (operation, sha) => guarded(async () => {
        if (!a?.operations.includes(operation) || terminal) fail();
        if (operation === 'create-branch' && !/^[a-f0-9]{40}$/.test(sha ?? '')) fail();
        if (!helper || helper.expiresAt <= now()) {
          if (helper) helper.state = 'expired';
          try { await issue(); } catch {
            terminal = true;
            lifecycle = 'unverified';
            fail();
          }
        }
        if (helper.state !== 'usable' || helper.expiresAt <= now()) fail();
        if (operation === 'create-branch') {
          await request(helper.token, 'POST', `${target}/git/refs`,
            { ref: `refs/heads/${definition.name}`, sha });
        } else {
          await request(helper.token, 'DELETE',
            `${target}/git/refs/heads/${definition.name}`);
        }
        // Native resources are observed by the fixture adapter, not returned here.
        return metadata();
      }),
      revoke: () => guarded(async () => {
        terminal = true;
        let verified = !issuanceUnknown;
        for (const token of helpers) {
          if (token.state === 'revoked') continue;
          token.state = 'unverified';
          let requested = false;
          try {
            await request(token.token, 'DELETE', `${api}/installation/token`);
            requested = true;
          } catch { /* A lost response is not proof of revocation. */ }
          try {
            const observation = await request(token.token, 'GET',
              `${api}/installation/repositories`, null, 'revocation');
            if (requested && observation.status === 401) token.state = 'revoked';
          } catch { /* Unknown access is never successful cleanup. */ }
          if (token.state !== 'revoked') verified = false;
        }
        lifecycle = verified ? 'revoked' : 'unverified';
        return { status: lifecycle, requested: helpers.length,
          verified: helpers.filter(token => token.state === 'revoked').length };
      }),
    };
  };
}
