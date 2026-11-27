import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requireEnv } from '../src/host/config.ts';
import { createHostContext } from '../src/host/context.ts';
import type { Exec } from '../src/host/exec.ts';
import { createGitHub } from '../src/host/github.ts';
import { readTemplate, treeSha } from '../src/host/sandbox.ts';
import type { HostServices } from '../src/host/services.ts';
import { claudeRunnersLeft, createProvisioning } from '../src/provisioning.ts';
import type { Platform, RunContext, StepOutcome } from '../src/types.ts';
import { FakeGitHub, cleanRepo, fakeExec, fakeStart } from './host/fakes.ts';

const EXEC = 'taco3064/nibfin-e2e-sandbox';
const PEER = 'taco3064/nibfin-e2e-sandbox-peer';
const repoRoot = join(import.meta.dirname, '..');
const tree = treeSha(readTemplate(join(repoRoot, 'sandbox-template')));
const COMMIT = 'a'.repeat(40);
const DIGEST = 'sha256:' + 'd'.repeat(64);

function harness(opts: { exec?: Exec; env?: Record<string, string>; fetch?: typeof fetch; platform?: Platform } = {}) {
  const fake = new FakeGitHub();
  fake.repos.set(EXEC, cleanRepo('public', tree));
  fake.repos.set(PEER, cleanRepo('private', tree));
  const env: Record<string, string | undefined> = opts.env ?? { E2E_SANDBOX_TOKEN: 'sbx-token', E2E_CLAUDE_TOKEN: 'claude-token' };
  const work = mkdtempSync(join(tmpdir(), 'e2e-work-'));
  const recorded = fakeExec();
  const sandboxToken = () => requireEnv(env, 'E2E_SANDBOX_TOKEN');
  const services: HostServices = {
    env,
    exec: opts.exec ?? recorded.exec,
    start: fakeStart().start,
    fetch: opts.fetch ?? fake.fetch,
    github: createGitHub(sandboxToken, fake.fetch),
    repoRoot,
    workDir: () => work,
    sandboxToken,
    peerGithub: createGitHub(() => requireEnv(env, 'E2E_PEER_GITHUB_TOKEN'), fake.fetch),
    peerToken: () => requireEnv(env, 'E2E_PEER_GITHUB_TOKEN'),
  };
  const steps = new Map(createProvisioning(services).map((s) => [s.id, s]));
  const facts = new Map<string, Record<string, unknown> | undefined>();
  const ctx: RunContext = {
    ...createHostContext(services),
    target: { ghNibfinCommit: COMMIT, platform: opts.platform ?? 'linux' },
    log: () => {},
    facts: (id) => facts.get(id),
    defer: () => {},
    upcoming: () => [],
  };
  const runStep = async (id: string): Promise<StepOutcome> => {
    const out = await (steps.get(id)?.run(ctx) as Promise<StepOutcome>);
    facts.set(id, out.facts);
    return out;
  };
  const teardown = (id: string) => steps.get(id)?.teardown?.(ctx);
  return { fake, calls: recorded.calls, runStep, teardown, steps, repo: (r: string) => fake.repos.get(r) as ReturnType<typeof cleanRepo> };
}

test('the steps are registered in order with their prerequisites', () => {
  const { steps } = harness();
  deepEqual([...steps.values()].map((s) => [s.id, s.requires ?? []]), [
    ['gh-nibfin', []],
    ['podman', []],
    ['claude-login', ['podman']],
    ['sandboxes', []],
    ['nibfin', ['gh-nibfin', 'podman', 'claude-login', 'sandboxes']],
    ['observed-job', ['nibfin']],
    ['collaborator', ['gh-nibfin', 'podman', 'nibfin']],
  ]);
});

test('sandboxes: an online runner on the execution sandbox fails before any write, and teardown leaves it alone', async () => {
  const h = harness();
  h.repo(EXEC).runners.push({ id: 1, name: 'other-host', status: 'online' });
  h.repo(PEER).labels.push('scope');
  const out = await h.runStep('sandboxes');
  equal(out.status, 'failed');
  match(out.reason, /another host appears to be using the sandboxes: runner registrations other-host are online.*one after another/);
  deepEqual(await h.teardown('sandboxes'), { status: 'passed', reason: 'this host did not reset the sandboxes; nothing to clean' });
  deepEqual(h.fake.writes, []);
});

test('sandboxes: offline registrations are crash leftovers and are deleted; teardown resets and reads back again', async () => {
  const h = harness();
  h.repo(EXEC).runners.push({ id: 1, name: 'dead-host', status: 'offline' });
  const out = await h.runStep('sandboxes');
  equal(out.status, 'passed', out.reason);
  deepEqual(h.repo(EXEC).runners, []);
  h.repo(PEER).secrets.push('NIBFIN_GITHUB_TOKEN');
  equal((await h.teardown('sandboxes'))?.status, 'passed');
  deepEqual(h.repo(PEER).secrets, []);
});

test('sandboxes: a missing token fails naming the variable', async () => {
  const h = harness({ env: { E2E_CLAUDE_TOKEN: 'c' } });
  await rejects(h.runStep('sandboxes'), /missing environment variable E2E_SANDBOX_TOKEN/);
});

function initPr(repo: ReturnType<typeof cleanRepo>, number: number, workflows: Record<string, string>) {
  repo.pulls.push({
    number,
    state: 'open',
    head: { sha: `h${number}` },
    files: Object.entries(workflows).map(([name, content]) => ({ filename: `.github/workflows/${name}`, status: 'added', content })),
  });
}

const image = (d: string) => `    run: podman run ghcr.io/taco3064/nibfin@${d} core\n`;

test('nibfin: runner add, init on execution then peer, digest read from the init PR, both PRs rebase-merged', async () => {
  const h = harness();
  initPr(h.repo(EXEC), 5, { 'nibfin-issue.yml': image(DIGEST), 'nibfin-shared-runner.yml': image(DIGEST) + image(DIGEST) });
  initPr(h.repo(PEER), 3, { 'nibfin-issue.yml': 'on: issues\n' });
  const out = await h.runStep('nibfin');
  equal(out.status, 'passed', out.reason);
  equal(out.facts?.imageDigest, DIGEST);
  deepEqual([out.facts?.executionPr, out.facts?.peerPr], [5, 3]);
  const gh = h.calls.filter((c) => c.argv[0] === 'gh');
  deepEqual(gh.map((c) => c.argv.slice(2)), [
    ['runner', 'add', 'claude', '--count', '2', '--yes'],
    ['init', '--yes'],
    ['init', '-R', PEER, '--yes'],
  ]);
  equal(gh.every((c) => c.options.ghToken === 'sbx-token' && c.options.cwd?.endsWith(join('.e2e-work', 'sandbox'))), true);
  const clone = h.calls[0];
  deepEqual(clone?.argv.slice(0, 4), ['git', 'clone', '--quiet', `https://github.com/${EXEC}.git`]);
  equal(clone?.options.ghToken, undefined);
  deepEqual([h.repo(EXEC).pulls[0]?.state, h.repo(PEER).pulls[0]?.state], ['closed', 'closed']);
  deepEqual(h.repo(EXEC).mainFiles, new Set(['.github/workflows/nibfin-issue.yml', '.github/workflows/nibfin-shared-runner.yml']));
  // The baselines are main's head and tree read after the merges.
  deepEqual(out.facts?.executionBaseline, { commit: 'merge5', tree: 'tree-merge5' });
  deepEqual(out.facts?.peerBaseline, { commit: 'merge3', tree: 'tree-merge3' });

  equal((await h.teardown('nibfin'))?.status, 'passed');
  deepEqual(h.calls.at(-1)?.argv, ['gh', 'nibfin', 'runner', 'remove', 'claude', '--yes']);
});

test('nibfin: more than one open PR after init fails', async () => {
  const h = harness();
  initPr(h.repo(EXEC), 5, { 'a.yml': image(DIGEST) });
  initPr(h.repo(EXEC), 6, { 'b.yml': image(DIGEST) });
  const out = await h.runStep('nibfin');
  equal(out.status, 'failed');
  match(out.reason, /expected exactly one open pull request after init, found 2/);
});

test('nibfin: a missing or conflicting digest fails', async () => {
  const none = harness();
  initPr(none.repo(EXEC), 5, { 'a.yml': 'ghcr.io/taco3064/nibfin:latest\n' });
  initPr(none.repo(PEER), 3, {});
  match((await none.runStep('nibfin')).reason, /pins no ghcr.io\/taco3064\/nibfin@sha256 image/);
  const two = harness();
  initPr(two.repo(EXEC), 5, { 'a.yml': image(DIGEST), 'b.yml': image('sha256:' + 'e'.repeat(64)) });
  initPr(two.repo(PEER), 3, {});
  const out = await two.runStep('nibfin');
  match(out.reason, /conflicting image digests/);
  equal(out.facts?.imageDigest, undefined);
});

test('nibfin: a failed runner add keeps its output in the facts, and teardown still removes Runners', async () => {
  const { exec, calls } = fakeExec((argv) => (argv[2] === 'runner' && argv[3] === 'add' ? { code: 1, stderr: 'no podman machine exists' } : undefined));
  const h = harness({ exec });
  const out = await h.runStep('nibfin');
  equal(out.status, 'failed');
  match(out.reason, /gh nibfin runner add claude --count 2 --yes exited 1: no podman machine exists/);
  deepEqual((out.facts?.commands as { code: number }[]).map((c) => c.code), [1]);
  equal((await h.teardown('nibfin'))?.status, 'passed');
  deepEqual(calls.at(-1)?.argv.slice(2, 4), ['runner', 'remove']);
});

test('claude-login: the token reaches the helper only on stdin; a new file is 0600 for the host user', async () => {
  let written = '';
  const { exec, calls } = fakeExec((argv, o) => {
    const script = argv.at(-1) ?? '';
    if (script.startsWith('umask')) return ((written = o.input ?? ''), {});
    if (script.startsWith('stat')) return { stdout: written ? `0 755\n0 600\n${written}` : '0 755\n-\n' };
    return undefined;
  });
  const h = harness({ exec });
  const out = await h.runStep('claude-login');
  equal(out.status, 'passed', out.reason);
  deepEqual(JSON.parse(written), { env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' } });
  equal(calls.some((c) => c.argv.join(' ').includes('claude-token')), false);
  equal(out.reason.includes('claude-token'), false);
  deepEqual(calls[0]?.argv, ['podman', 'volume', 'create', '--ignore', 'nibfin-home-claude']);
  const write = calls.find((c) => c.options.input);
  deepEqual(write?.argv.slice(0, 6), ['podman', 'run', '--rm', '-i', '-v', 'nibfin-home-claude:/v']);
  match(write?.argv[6] ?? '', /^docker\.io\/library\/busybox:[\d.]+@sha256:[0-9a-f]{64}$/);
  equal(write?.argv.at(-1), 'umask 077 && cat > /v/settings.json');
  equal(calls.some((c) => c.argv.some((a) => /chown|chmod|--userns/.test(a))), false);
});

test('claude-login: other keys, the owner and the mode of an existing file are kept', async () => {
  let written = '';
  const { exec } = fakeExec((argv, o) => {
    const script = argv.at(-1) ?? '';
    if (script.startsWith('umask')) return ((written = o.input ?? ''), {});
    if (script.startsWith('stat')) return { stdout: `0 755\n0 644\n${written || '{"enableAllProjectMcpServers":true,"env":{"A":"1"}}'}` };
    return undefined;
  });
  const out = await harness({ exec }).runStep('claude-login');
  equal(out.status, 'passed', out.reason);
  deepEqual(JSON.parse(written), { enableAllProjectMcpServers: true, env: { A: '1', CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' } });
});

test('claude-login: a read-back with the wrong mode fails without printing the token; Windows starts and stops the machine', async () => {
  let written = '';
  const { exec, calls } = fakeExec((argv, o) => {
    const script = argv.at(-1) ?? '';
    if (script.startsWith('umask')) return ((written = o.input ?? ''), {});
    if (script.startsWith('stat')) return { stdout: written ? `0 755\n0 644\n${written}` : '0 755\n-\n' };
    return undefined;
  });
  const h = harness({ exec, platform: 'windows' });
  const err = await h.runStep('claude-login').catch((e: Error) => e.message);
  match(String(err), /settings.json is "0 644", expected "0 600"/);
  equal(String(err).includes('claude-token'), false);
  deepEqual([calls[0]?.argv, calls.at(-1)?.argv], [['podman', 'machine', 'start'], ['podman', 'machine', 'stop']]);
});

test('gh-nibfin: builds the Dashboard first, then the binary, installs it and checks it runs', async () => {
  const { exec, calls } = fakeExec((argv) => (argv[1] === 'rev-parse' ? { stdout: COMMIT + '\n' } : undefined));
  const out = await harness({ exec }).runStep('gh-nibfin');
  equal(out.status, 'passed', out.reason);
  deepEqual(calls.map((c) => c.argv.slice(0, 3).join(' ')), [
    'git clone --quiet',
    'git checkout --quiet',
    'git rev-parse HEAD',
    'npm ci',
    'npm run build',
    'go build -trimpath',
    'gh extension remove',
    'gh extension install',
    'gh nibfin --help',
  ]);
  equal(calls[3]?.options.cwd?.endsWith(join('gh-nibfin', 'dashboard')), true);
  deepEqual(calls[5]?.argv.slice(3), ['-o', 'gh-nibfin', '.']);
  deepEqual(calls.map((c) => c.options.ghToken === 'sbx-token'), [false, false, false, false, false, false, true, true, true]);
});

test('gh-nibfin: a checkout at another commit fails', async () => {
  const { exec } = fakeExec((argv) => (argv[1] === 'rev-parse' ? { stdout: 'b'.repeat(40) } : undefined));
  await rejects(harness({ exec }).runStep('gh-nibfin'), /gh-nibfin checkout is at b{40}, expected a{40}/);
});

test('podman: Linux checks podman runs; macOS is out of scope; a Windows MSI with the wrong checksum is not installed', async () => {
  const linux = harness();
  equal((await linux.runStep('podman')).status, 'passed');
  deepEqual(linux.calls.map((c) => c.argv), [['podman', '--version']]);
  await rejects(harness({ platform: 'macos' }).runStep('podman'), /macOS host provisioning is not supported \(Phase 5\)/);
  const win = harness({ platform: 'windows', fetch: async () => new Response('not the msi') });
  await rejects(win.runStep('podman'), /Podman MSI checksum mismatch/);
  deepEqual(win.calls, []);
});

test('nibfin: teardown passes without runner remove when status lists no claude Runner', async () => {
  const { exec, calls } = fakeExec((argv) =>
    argv[2] === 'status' ? { stdout: JSON.stringify({ host: { runners: { runners: [{ provider: 'codex' }] } } }) } : undefined,
  );
  const h = harness({ exec });
  initPr(h.repo(EXEC), 5, { 'nibfin-issue.yml': image(DIGEST) });
  initPr(h.repo(PEER), 3, { 'nibfin-issue.yml': 'on: issues\n' });
  equal((await h.runStep('nibfin')).status, 'passed');
  deepEqual(await h.teardown('nibfin'), { status: 'passed', reason: 'no local Runners left' });
  equal(calls.some((c) => c.argv[3] === 'remove'), false);
  deepEqual([claudeRunnersLeft('{"host":{"runners":{"runners":null}}}'), claudeRunnersLeft('not json'), claudeRunnersLeft('{"host":{"runners":{"runners":[{"provider":"claude"}]}}}')], [false, undefined, true]);
});

test('nibfin: the host state before runner add is a fact', async () => {
  const { exec } = fakeExec((argv) => {
    if (argv[0] === 'systemctl') return { stdout: 'a.service enabled enabled\nb.timer static -\n' };
    if (argv[0] === 'loginctl') return { stdout: 'no\n' };
    return undefined;
  });
  const h = harness({ exec });
  initPr(h.repo(EXEC), 5, { 'nibfin-issue.yml': image(DIGEST) });
  initPr(h.repo(PEER), 3, { 'nibfin-issue.yml': 'on: issues\n' });
  const out = await h.runStep('nibfin');
  const before = out.facts?.hostBefore as { platform: string; units: unknown; linger: string };
  deepEqual([before.platform, before.units, before.linger], ['linux', [{ name: 'a.service', state: 'enabled' }, { name: 'b.timer', state: 'static' }], 'no']);
});
