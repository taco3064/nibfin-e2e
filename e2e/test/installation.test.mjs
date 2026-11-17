import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installationFixture } from './installation-fixture.mjs';
import { pin, put } from './source-fixture.mjs';
import { decodeRunnerCommand, protectedSharedInstallation } from '../runner-live.mjs';
import { compareInstallationResult } from '../runner-observations.mjs';

const noSecrets = value => assert(!JSON.stringify(value).includes('secret'));

test('shared install uses prepared CLI, independent reads and durable upstream state',
  async t => {
    const f = await installationFixture(t);
    const first = await f.driver().install();
    assert.equal(first.disposition, 'success');
    assert.equal(first.phase, 'installed');
    assert.equal(first.origin, 'synthetic');
    assert.equal(first.protectedExecution, 'unverified');
    assert.equal(compareInstallationResult(first).outcome, 'unverified');
    assert.deepEqual(first.inventory.runners.map(r => r.id), [41, 42]);
    assert.equal(first.inventory.repositories.length, 2);
    assert.equal(first.observation.installation.pullRequest.number, 1);
    assert.equal(first.observation.host.serviceUser, 'nibfin-runner');
    const second = await f.driver().install();
    assert.equal(second.disposition, 'success');
    assert.deepEqual(second.inventory.runners.map(r => r.id), [41, 42]);
    assert.equal(f.commands.length, 1);
    assert.equal((await f.read()).repositories[0].creation, 'settled');
    noSecrets(first);
  });

for (const condition of ['pending', 'unreviewed', 'unmerged', 'content', 'host']) {
  test(`${condition} prerequisites cause bounded handoff without installation effects`,
    async t => {
      const f = await installationFixture(t);
      const p = f.observation.installation;
      if (condition === 'pending') p.checks = 'pending';
      if (condition === 'unreviewed') p.reviewed = false;
      if (condition === 'unmerged') p.merged = false;
      if (condition === 'content') p.contentMatches = false;
      if (condition === 'host') f.observation.host.ready = false;
      const result = await f.driver().install();
      assert.equal(result.disposition, 'incomplete');
      assert.equal(f.commands.length, 0);
      assert.equal(result.inventory.repositories.length, 2);
    });
}

test('external review/merge is freshly consumed on a later invocation', async t => {
  const f = await installationFixture(t);
  f.observation.installation.merged = false;
  assert.equal((await f.driver().install()).phase, 'installation-pr');
  f.observation.installation.merged = true;
  assert.equal((await f.driver().install()).disposition, 'success');
});

test('lost partial registration is reconciled before reusing its identity', async t => {
  const f = await installationFixture(t);
  const command = f.context.command;
  f.context.command = async () => {
    f.observation.runners = [f.runner(41)];
    throw new Error('secret lost response');
  };
  const first = await f.driver().install();
  assert.equal(first.disposition, 'incomplete');
  assert(first.inventory.pending);
  const events = [];
  f.context.reconcile = async () => {
    events.push('reconcile');
    return { terminated: true, effects: 'reconciled' };
  };
  f.context.command = async (...args) => {
    events.push('command');
    assert.equal(f.observation.runners[0].id, 41);
    return command(...args);
  };
  const second = await f.driver().install();
  assert.equal(second.disposition, 'success');
  assert.deepEqual(events, ['reconcile', 'command', 'reconcile']);
  assert.deepEqual(second.inventory.runners.map(r => r.id), [41, 42]);
  noSecrets(first);
});

for (const condition of ['termination', 'effects', 'hung-reconcile', 'unknown-read']) {
  test(`${condition} never blindly repeats an interrupted apply`, async t => {
    const f = await installationFixture(t);
    f.context.command = async () => { throw new Error('secret'); };
    await f.driver().install();
    f.context.command = async () => { assert.fail('unsafe repeated command'); };
    f.context.reconcile = async () => condition === 'hung-reconcile' ?
      new Promise(() => {}) : { terminated: condition !== 'termination',
        effects: condition === 'effects' ? 'unknown' : 'reconciled' };
    if (condition === 'unknown-read') f.observation.registrationsComplete = null;
    const result = await f.driver({ requestTimeoutMs: 100 }).install();
    assert.equal(result.disposition, 'incomplete');
    assert(result.inventory.pending);
    noSecrets(result);
  });
}

for (const condition of ['endpoint', 'tampered', 'duplicate', 'member', 'local',
  'repository', 'source', 'failed-check', 'extra-runner']) {
  test(`${condition} contradiction prevents further installation effects`, async t => {
    const f = await installationFixture(t);
    await f.driver().install();
    const o = f.observation;
    if (condition === 'endpoint') o.endpoint = 'https://github.com/wrong/repository';
    if (condition === 'tampered') o.runners[0] = f.runner(99);
    if (condition === 'duplicate') o.runners[1] = o.runners[0];
    if (condition === 'member') o.runners[0].memberId = 10;
    if (condition === 'local') o.runners[0].localId = 99;
    if (condition === 'repository') o.binding.repositoryId = 99;
    if (condition === 'source') o.sources.action.commit = 'e'.repeat(40);
    if (condition === 'failed-check') o.installation.checks = 'failed';
    if (condition === 'extra-runner') o.runners.push(f.runner(43));
    const result = await f.driver().install();
    assert.equal(result.disposition, 'contradiction');
    assert.equal(f.commands.length, 1);
  });
}

for (const condition of ['online', 'service', 'sources', 'endpoint', 'local', 'reads']) {
  test(`unknown ${condition} cannot establish installation success`, async t => {
    const f = await installationFixture(t);
    const command = f.context.command;
    f.context.command = async (...args) => {
      const result = await command(...args);
      if (condition === 'online') f.observation.runners[0].status = null;
      if (condition === 'service') f.observation.host.serviceUser = null;
      if (condition === 'sources') f.observation.sources.core.commit = null;
      if (condition === 'endpoint') f.observation.endpoint = null;
      if (condition === 'local') f.observation.runners[0].localId = null;
      if (condition === 'reads') f.observation.registrationsComplete = false;
      return result;
    };
    assert.equal((await f.driver().install()).disposition, 'incomplete');
  });
}

for (const declaration of ['Action Core', 'CLI Core', 'CLI Action']) {
  test(`${declaration} incompatibility stops before any host command`, async t => {
    const f = await installationFixture(t);
    if (declaration === 'Action Core') {
      await writeFile(join(f.sources.action.checkout, 'core-source.json'), '{}');
    } else {
      await put(f.sources.cli.checkout, 'internal/cli/producers.json', {
        core: declaration === 'CLI Core' ? {} : pin, action: {},
      });
    }
    const result = await f.driver().install();
    assert.equal(result.disposition, 'contradiction');
    assert.equal(result.phase, 'source-compatibility');
    assert.equal(f.commands.length, 0);
    noSecrets(result);
  });
}

for (const denied of ['inspect-installation', 'start-shared-services']) {
  test(`${denied} denial names refused operation and identity without diagnostics`,
    async t => {
      const f = await installationFixture(t, { denied });
      const result = await f.driver().install();
      assert.equal(result.disposition, 'denied');
      assert.equal(result.refused.operation, denied);
      assert.equal(result.refused.memberId, 9);
      assert(result.refused.expectedRole);
      assert.equal(f.commands.length, 0);
      noSecrets(result);
    });
}

test('hung command retains intent for termination reconciliation', async t => {
  const f = await installationFixture(t);
  let aborted = false;
  f.context.command = async (file, args, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  };
  const result = await f.driver({ requestTimeoutMs: 20 }).install();
  assert.equal(result.disposition, 'incomplete');
  assert(aborted);
  assert(result.inventory.pending);
});

for (const condition of ['owner', 'member', 'repository', 'host', 'credentials']) {
  test(`mismatched ${condition} binding stops before effects`, async t => {
    const f = await installationFixture(t);
    if (condition === 'owner') f.context.binding.owner = 'other';
    if (condition === 'member') f.context.binding.memberId = 10;
    if (condition === 'repository') f.context.binding.repositoryId = 99;
    if (condition === 'credentials') f.context.credentials.capabilities = async () =>
      ({ user: { status: 'validated', actorId: 10 } });
    if (condition === 'host') {
      await f.driver().install();
      f.context.binding.hostId = 'another-host';
    }
    const before = f.commands.length;
    assert.equal((await f.driver().install()).disposition, 'contradiction');
    assert.equal(f.commands.length, before);
  });
}

test('ordinary scenario input cannot construct protected installation', () => {
  assert.throws(() => protectedSharedInstallation({ context: { apply: true } }),
    /PROTECTED_INSTALLATION_CONTEXT_REQUIRED/);
});

test('CLI shared installation decoder retains bounded fields only', () => {
  const result = decodeRunnerCommand({ exitCode: 2, stdout: JSON.stringify({
    status: 'pending', code: 'SHARED_PROTECTED_EXECUTION_UNVERIFIED',
    pull_request: 'https://github.com/a/b/pull/1',
    shared_service_template: 'installed', shared_core_deployment: 'deployed',
    shared_runners: [{ id: 41, name: 'shared-41', status: 'online', busy: false,
      diagnostic: 'secret' }], diagnostic: 'secret',
  }) });
  assert.equal(result.results[0].shared_runners[0].id, 41);
  assert.equal(result.results[0].shared_service_template, 'installed');
  noSecrets(result);
});

for (const operation of ['read-runner-registrations', 'start-shared-services']) {
  test(`native ${operation} permission refusal is sanitized`, async t => {
    const f = await installationFixture(t);
    const refuse = async () => {
      const error = new Error('secret raw provider diagnostics');
      error.code = 'INSTALLATION_PERMISSION_DENIED';
      error.operation = operation;
      throw error;
    };
    if (operation === 'read-runner-registrations') f.context.observe = refuse;
    else f.context.command = refuse;
    const result = await f.driver().install();
    assert.equal(result.disposition, 'denied');
    assert.equal(result.refused.operation, operation);
    assert.equal(result.refused.memberId, 9);
    noSecrets(result);
  });
}

test('unavailable provider read is bounded and never triggers an apply', async t => {
  const f = await installationFixture(t);
  f.context.observe = async () => new Promise(() => {});
  const result = await f.driver({ requestTimeoutMs: 100 }).install();
  assert.equal(result.disposition, 'incomplete');
  assert.equal(f.commands.length, 0);
  assert.equal(result.inventory.repositories.length, 2);
});

test('unknown registration cannot hide a known wrong endpoint', async t => {
  const f = await installationFixture(t);
  f.observation.runners = [f.runner(41), f.runner(42)];
  f.observation.runners[0].shared = null;
  f.observation.runners[1].endpoint = 'https://github.com/wrong/endpoint';
  assert.equal((await f.driver().install()).disposition, 'contradiction');
  assert.equal(f.commands.length, 0);
});

test('lost startup response reconciles to success without another command', async t => {
  const f = await installationFixture(t);
  const command = f.context.command;
  f.context.command = async (...args) => {
    await command(...args);
    throw new Error('secret lost startup response');
  };
  const first = await f.driver().install();
  assert(first.inventory.pending);
  const second = await f.driver().install();
  assert.equal(second.disposition, 'success');
  assert.equal(second.inventory.pending, null);
  assert.equal(f.commands.length, 1);
});

test('executor termination is required even with online native reads', async t => {
  const f = await installationFixture(t);
  const command = f.context.command;
  f.context.command = async (...args) => ({ ...await command(...args),
    terminated: false });
  const result = await f.driver().install();
  assert.equal(result.disposition, 'incomplete');
  assert.equal(result.phase, 'reconciliation');
  assert(result.inventory.pending);
});

test('operator comparison verifies facts and does not certify protected execution',
  async t => {
    const f = await installationFixture(t);
    f.context.origin = 'operator';
    const result = await f.driver().install();
    assert.equal(compareInstallationResult(result).outcome, 'passed');
    assert.equal(compareInstallationResult(result).protectedExecution, 'unverified');
    result.observation.runners[0].status = 'offline';
    assert.equal(compareInstallationResult(result).outcome, 'failing');
  });

test('core package identity must match the prepared source identity', async t => {
  const f = await installationFixture(t);
  f.sources.core.output.pin.commit = 'd'.repeat(40);
  assert.equal((await f.driver().install()).disposition, 'contradiction');
  assert.equal(f.commands.length, 0);
});

test('an incomplete registration page preserves earlier IDs without inventing absence',
  async t => {
    const f = await installationFixture(t);
    await f.driver().install();
    f.observation.registrationsComplete = false;
    f.observation.runners = [];
    const result = await f.driver().install();
    assert.equal(result.disposition, 'incomplete');
    assert.deepEqual(result.inventory.runners.map(r => r.id), [41, 42]);
    assert.equal(f.commands.length, 1);
  });

test('unknown ID cannot conceal a known wrong registration endpoint', async t => {
  const f = await installationFixture(t);
  f.observation.runners = [f.runner(41)];
  f.observation.runners[0].id = null;
  f.observation.runners[0].endpoint = 'https://github.com/wrong/endpoint';
  assert.equal((await f.driver().install()).disposition, 'contradiction');
});

test('falsy native failures remain bounded incomplete observations', async t => {
  const f = await installationFixture(t);
  f.context.observe = async () => { throw null; };
  const result = await f.driver().install();
  assert.equal(result.disposition, 'incomplete');
  assert.equal(f.commands.length, 0);
});

test('a refused binding preserves the existing host recovery inventory', async t => {
  const f = await installationFixture(t);
  const command = f.context.command;
  f.context.command = async (...args) => {
    await command(...args);
    throw new Error('secret');
  };
  const first = await f.driver().install();
  f.context.binding.hostId = 'wrong-host';
  const refused = await f.driver().install();
  assert.equal(refused.disposition, 'contradiction');
  assert.equal(refused.inventory.hostId, first.inventory.hostId);
  assert.deepEqual(refused.inventory.pending, first.inventory.pending);
  assert.deepEqual((await f.read()).installation.pending, first.inventory.pending);
});
