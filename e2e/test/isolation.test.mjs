import assert from 'node:assert/strict';
import test from 'node:test';
import { scenarios, select } from '../registry.mjs';
import { execute } from '../execution.mjs';
import * as host from '../scenarios/isolation-host.mjs';
import { environment } from '../scenarios/isolation-common.mjs';

const core = {
  repository: 'example/core', commit: 'a'.repeat(40), checkout: '/synthetic/core',
};
test('wake, local and host selections remain independently selectable', () => {
  assert.deepEqual(select(scenarios, ['wake-contract']).map(row => row.id), [
    'wake.action.fixture', 'wake.shared-issue.fixture',
  ]);
  assert.equal(select(scenarios,
    ['wake-contract', 'isolation.local', 'isolation.host']).length, 7);
  assert.equal(select(scenarios, ['isolation.local']).length, 1);
  assert.equal(select(scenarios, ['isolation.host']).length, 4);
});
test('missing prepared Core blocks local and host checks', async () => {
  for (const scenario of scenarios.filter(s => s.group.startsWith('isolation.'))) {
    const result = await execute(scenario);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reason.code, 'PREREQUISITE_MISSING');
  }
});
test('source availability never supplies protected host authority', async () => {
  for (const scenario of select(scenarios, ['isolation.host'])) {
    const result = await execute(scenario, { sources: { core } });
    assert.equal(result.outcome, process.platform === 'linux'
      ? 'blocked' : 'unverified');
    assert.ok(result.reason.message.includes(process.platform));
    assert.ok(result.reason.message.includes(process.version));
    assert.ok(result.reason.message.includes(core.commit));
  }
});
test('unobserved host results and injected claims cannot pass', () => {
  assert.equal(host.verify({ denied: true, authorized: true }), false);
  assert.equal(host.verify(host.run({ sources: { core } })), false);
});
test('report context identifies sources without retaining source private fields', () => {
  const report = environment({ sources: { core: { ...core, token: 'sentinel' } } },
    'synthetic/local');
  assert.equal(report.mode, 'synthetic/local');
  assert.equal(report.os, process.platform);
  assert.equal(report.node, process.version);
  assert.deepEqual(report.sources, [{
    repository: core.repository, commit: core.commit,
  }]);
  assert.equal(JSON.stringify(report).includes('sentinel'), false);
});
test('incomplete Core source fails without exposing imported errors', async () => {
  const scenario = select(scenarios, ['isolation.local'])[0];
  const result = await execute(scenario, { sources: { core } });
  assert.equal(result.outcome, 'failing');
  assert.equal(result.reason.message, 'ISOLATION_CONTRACT_ASSERTION_FAILED');
  assert.equal(result.reason.message.includes('/synthetic'), false);
});
