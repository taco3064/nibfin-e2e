import { deepEqual, equal, match, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import type { HostServices } from '../src/host/services.ts';
import { createProvisioning } from '../src/provisioning.ts';
import { run } from '../src/run.ts';
import { select } from '../src/select.ts';
import type { ProvisioningStep, RunTarget } from '../src/types.ts';
import { collaboratorScenarios } from '../scenarios/collaborator/index.ts';
import { until } from '../scenarios/collaborator/observe.ts';
import {
  checkStatus,
  classifyJob,
  parseRegistrationComment,
  parseRequestBody,
  replaceDigest,
  rogueWorkflow,
  tamperTemplate,
  unsignedDigest,
} from '../scenarios/collaborator/parse.ts';
import type { Job } from '../scenarios/collaborator/parse.ts';
import { fakeHostContext, step } from './fixtures.ts';

const SHA = 'b'.repeat(40);
const DIGEST = 'sha256:' + 'd'.repeat(64);

test('request bodies: marker, one ssh-key-id and an optional deploy-key', () => {
  deepEqual(parseRequestBody('Text\n<!-- nibfin:runner-request -->\nssh-key-id: 77\n'), { marker: true, sshKeyIds: ['77'], deployKeys: [] });
  deepEqual(parseRequestBody('<!-- nibfin:runner-request -->\r\nssh-key-id: 1\r\nssh-key-id: 2\r\ndeploy-key: ssh-ed25519 AAAA\r\n'), {
    marker: true,
    sshKeyIds: ['1', '2'],
    deployKeys: ['ssh-ed25519 AAAA'],
  });
  deepEqual(parseRequestBody(null), { marker: false, sshKeyIds: [], deployKeys: [] });
});

test('the registration answer is recognised only with its marker, its fields and an age block', () => {
  const body = [
    '<!-- nibfin:runner-registration -->',
    'requester: peer-login',
    'ssh-key-id: 77',
    'expires-at: 2026-11-26T11:00:00Z',
    '',
    'Run runner add.',
    '',
    '```text',
    '-----BEGIN AGE ENCRYPTED FILE-----',
    'YWdl',
    '-----END AGE ENCRYPTED FILE-----',
    '```',
  ].join('\n');
  deepEqual(parseRegistrationComment(body), { requester: 'peer-login', sshKeyId: '77', expiresAt: '2026-11-26T11:00:00Z', armored: true });
  equal(parseRegistrationComment(body.replace('<!-- nibfin:runner-registration -->', '<!-- nibfin:runner-request-refused -->')), undefined);
  equal(parseRegistrationComment(body.replace('requester: peer-login\n', '')), undefined);
  equal(parseRegistrationComment(body.replace(/-----BEGIN[\s\S]*FILE-----/, ''))?.armored, false);
});

const job = (over: Partial<Job> = {}): Job => ({
  id: 9,
  run_id: 3,
  status: 'completed',
  conclusion: 'success',
  labels: ['self-hosted', 'nibfin-4242'],
  runner_name: 'host-claude-1',
  head_sha: SHA,
  ...over,
});
const ACCEPTED = `Set up runner\nNibfin hook: accepted o/exec@${SHA}, image ${DIGEST}\nNibfin image: ghcr.io/taco3064/nibfin@${DIGEST}\n`;
const REFUSED = 'Set up runner\nNibfin hook: refused: the workflow is not nibfin-shared-runner.yml. Use the official template.\n';

test('hook classification: accepted, refused, a step on a refused Job, no hook line, another runner', () => {
  const mine = ['host-claude-1'];
  deepEqual(classifyJob(job(), ACCEPTED, mine, ['Nibfin image:']), { kind: 'accepted', repo: 'o/exec', sha: SHA, digest: DIGEST });
  deepEqual(classifyJob(job({ conclusion: 'failure' }), REFUSED, mine, ['Nibfin image:', 'e2e-rogue-step-n']), {
    kind: 'refused',
    reason: 'the workflow is not nibfin-shared-runner.yml. Use the official template.',
  });
  match(String((classifyJob(job({ conclusion: 'failure' }), REFUSED + 'e2e-rogue-step-n\n', mine, ['e2e-rogue-step-n']) as { why: string }).why), /a step ran \(e2e-rogue-step-n\)/);
  match(String((classifyJob(job({ conclusion: 'success' }), REFUSED, mine, []) as { why: string }).why), /refused but concluded success/);
  match(String((classifyJob(job(), 'Set up runner\n', mine, []) as { why: string }).why), /no Nibfin hook line/);
  match(String((classifyJob(job({ runner_name: 'owner-claude-1' }), ACCEPTED, mine, []) as { why: string }).why), /not on the collaborator's Runners/);
  match(String((classifyJob(job(), ACCEPTED.replace(/Nibfin image:.*\n/, ''), mine, []) as { why: string }).why), /no step printed "Nibfin image:"/);
  match(String((classifyJob(job({ status: 'in_progress' }), ACCEPTED, mine, []) as { why: string }).why), /in_progress/);
  match(String((classifyJob(job({ head_sha: 'c'.repeat(40) }), ACCEPTED, mine, []) as { why: string }).why), /accepted for b+, not the run's head c+/);
});

test('the digest builder replaces exactly one IMAGE_REF digest and fails on zero or two', () => {
  const yml = `env:\n  IMAGE: ghcr.io/taco3064/nibfin\n  IMAGE_REF: ghcr.io/taco3064/nibfin@${DIGEST}\njobs: {}\n`;
  const fake = unsignedDigest('n1');
  match(fake, /^sha256:[0-9a-f]{64}$/);
  const out = replaceDigest(yml, fake);
  equal(out, yml.replace(DIGEST, fake));
  throws(() => replaceDigest('env: {}\n', fake), /has 0 IMAGE_REF lines/);
  throws(() => replaceDigest(yml + `  IMAGE_REF: ghcr.io/taco3064/nibfin@${DIGEST}\n`, fake), /has 2 IMAGE_REF lines/);
});

test('the template tamper only appends one comment line; the rogue workflow targets the label and echoes the nonce', () => {
  equal(tamperTemplate('a\nb\n', 'n'), 'a\nb\n# e2e tampered n\n');
  equal(tamperTemplate('a', 'n'), 'a\n# e2e tampered n\n');
  const rogue = rogueWorkflow('e2e-hook-rogue-n', 4242, 'n');
  match(rogue, /branches: \["e2e-hook-rogue-n"\]/);
  match(rogue, /runs-on: \[self-hosted, "nibfin-4242"\]/);
  match(rogue, /run: echo e2e-rogue-step-n/);
});

const status = (runners: unknown[], needsAdmin: unknown = true) => ({ host: { runners: { repo: 'o/exec', runners, githubNeedsAdmin: needsAdmin } } });
const local = { slot: 'claude-1', provider: 'claude', name: 'peerhost-claude-1', configured: true, unit: true, enabled: true, active: true, listed: false, busy: false };

test('status --json for a collaborator: githubNeedsAdmin, only local Runners, no GitHub status', () => {
  deepEqual(checkStatus(status([local]), 1, ['owner-claude-1']), []);
  deepEqual(checkStatus(status([local], false), 1, []), ['.host.runners.githubNeedsAdmin is false, expected true']);
  deepEqual(checkStatus(status([{ ...local, listed: true, status: 'online' }]), 1, []), [
    '.host.runners.runners[0] (claude-1).listed is true, expected false',
    '.host.runners.runners[0] (claude-1).status is "online", expected none (GitHub\'s state needs admin)',
  ]);
  deepEqual(checkStatus(status([local, { ...local, slot: 'x', name: 'owner-claude-1' }]), 1, ['owner-claude-1']), [
    ".host.runners.runners lists 2 Runners, expected the collaborator's 1",
    ".host.runners.runners[1] (x) is the Owner's registration owner-claude-1",
  ]);
  deepEqual(checkStatus(status([{ ...local, active: false }]), 1, []), ['.host.runners.runners[0] (claude-1).active is false, expected true']);
  deepEqual(checkStatus({}, 1, []), ['status --json has no .host.runners']);
});

test('until returns the first value and fails at the deadline with the last observed state', async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  let n = 0;
  equal(await until('x', async () => ({ value: ++n >= 3 ? n : undefined, state: `n=${n}` }), 60_000, clock, 10_000), 3);
  await rejects(until('the run', async () => ({ state: `at ${t}` }), 30_000, clock, 10_000), /the run: not observed within 30 s; last observed: at 50000/);
});

test('the collaborator step is blocked when nibfin failed, and its scenarios fail against it without teardown', async () => {
  const services = { peerToken: () => 'never', env: {} } as unknown as HostServices;
  const collaborator = createProvisioning(services).find((s) => s.id === 'collaborator') as ProvisioningStep;
  const steps = [
    step('gh-nibfin', { status: 'passed', reason: 'ok' }),
    step('podman', { status: 'passed', reason: 'ok' }),
    step('nibfin', { status: 'failed', reason: 'init failed' }),
    collaborator,
  ];
  const entries = [...new Set(collaboratorScenarios.flatMap((s) => s.rules))].map((id) => ({
    id,
    platforms: ['linux' as const],
    scenarios: collaboratorScenarios.filter((s) => s.rules.includes(id)).map((s) => s.id),
  }));
  const { selected } = select(entries, collaboratorScenarios, { all: true });
  const target: RunTarget = { ghNibfinCommit: 'a'.repeat(40), platform: 'linux' };
  const r = await run({ selection: { all: true }, selected, steps, target, host: fakeHostContext, log: () => {} });
  deepEqual(r.provisioning.find((p) => p.id === 'collaborator'), { id: 'collaborator', status: 'failed', reason: 'provisioning step nibfin failed: init failed' });
  equal(r.scenarios.length, 5);
  for (const s of r.scenarios) equal(s.reason, 'provisioning step collaborator failed: provisioning step nibfin failed: init failed');
  deepEqual(r.teardown, []);
  const windows = await run({ selection: { all: true }, selected, steps, target: { ...target, platform: 'windows' }, host: fakeHostContext, log: () => {} });
  deepEqual([windows.scenarios, windows.provisioning], [[], []]);
});
