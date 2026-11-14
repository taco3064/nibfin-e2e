import assert from 'node:assert/strict';
import { coreModule, environment } from './isolation-common.mjs';
export { prerequisite } from './isolation-common.mjs';

async function bindingControls(context) {
  const { runnerProviderFixture } = await coreModule(context,
    'test/runner-binding-fixture.mjs');
  const { readRunnerBinding } = await coreModule(context, 'src/runner-binding.mjs');
  const valid = runnerProviderFixture();
  const observed = await readRunnerBinding(valid.reader, valid.expected);
  assert.equal(observed.runnerId, valid.expected.runnerId);
  const cases = [
    [f => { f.runner.id++; }, 'ACTUAL_RUNNER_BINDING_MISMATCH'],
    [f => { f.repository.id++; }, 'RUNNER_REPOSITORY_CHANGED'],
    [f => { f.job.id++; }, 'ACTIONS_JOB_BINDING_MISMATCH'],
    [f => { f.run.run_attempt++; }, 'UNTRUSTED_ACTIONS_RUN'],
    [f => { f.job.run_attempt++; }, 'ACTIONS_JOB_BINDING_MISMATCH'],
    [f => { f.data['/collaborators/member/permission'].permission = 'read'; },
      'MEMBER_PERMISSION_REVOKED'],
  ];
  for (const [mutate, code] of cases) {
    const fixture = runnerProviderFixture();
    mutate(fixture);
    await assert.rejects(readRunnerBinding(fixture.reader, fixture.expected),
      error => error.message === code);
  }
  return cases.length + 1;
}
async function policyControls(context) {
  const { codexPlan } = await coreModule(context, 'src/codex-plan.mjs');
  const { digest } = await coreModule(context, 'src/identity.mjs');
  for (const stage of ['deliver', 'accept', 'shape']) {
    const content = 'Synthetic role contract';
    const plan = codexPlan(stage, {
      model: 'synthetic', context: {},
      skill: { identity: stage, content, hash: digest(content) },
    });
    const paths = plan.config['permissions.nibfin.filesystem'];
    assert.equal(paths['/work'], stage === 'deliver' ? 'write' : 'read');
    for (const path of ['/main', '/input']) assert.equal(paths[path], 'read');
    for (const path of ['/auth', '/agent-home', '/io']) {
      assert.equal(paths[path], 'deny');
    }
    assert.equal(plan.config.approval_policy, 'never');
    assert.equal(plan.config['shell_environment_policy.inherit'], 'none');
  }
  const { projectDomains, publicIPv4 } = await coreModule(context,
    'src/egress-proxy.mjs');
  assert.deepEqual(projectDomains(['example.com']), ['example.com']);
  for (const host of ['*.example.com', 'localhost', '127.0.0.1', 'x.internal']) {
    assert.throws(() => projectDomains([host]));
  }
  assert.equal(publicIPv4('8.8.8.8'), true);
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.1.1']) {
    assert.equal(publicIPv4(ip), false);
  }
  const { dockerBackend, validDockerEndpoint, verifyDockerSocket } =
    await coreModule(context, 'src/docker-backend.mjs');
  const backend = dockerBackend();
  assert.equal(validDockerEndpoint({
    docker: '/synthetic/docker', socket: '/run/user/1000/docker.sock',
  }, backend), true);
  assert.equal(validDockerEndpoint({
    docker: '/synthetic/docker', socket: '/var/run/docker.sock',
  }, backend), false);
  const socket = '/run/user/1000/docker.sock';
  const host = {
    platform: 'linux', uid: 1000,
    lstat: async () => ({ isSocket: () => true, uid: 1000, mode: 0o660 }),
    realpath: async () => socket,
  };
  await verifyDockerSocket(socket, backend, host);
  await assert.rejects(verifyDockerSocket(socket, backend, {
    ...host, realpath: async () => '/synthetic/redirect',
  }), /UNTRUSTED_DOCKER_SOCKET/);
  return true;
}
export async function run(context) {
  // These calls inspect maintained decisions; no host access or OS probe occurs.
  try {
    const bindings = await bindingControls(context);
    const policies = await policyControls(context);
    return { bindings, policies, observation: environment(context, 'synthetic/local') };
  } catch {
    // Never surface provider payloads or imported exceptions in diagnostics.
    throw new Error('ISOLATION_CONTRACT_ASSERTION_FAILED');
  }
}
export function verify(actual) {
  return actual.bindings === 7 && actual.policies === true;
}
export function describe(actual) {
  return JSON.stringify(actual.observation);
}
