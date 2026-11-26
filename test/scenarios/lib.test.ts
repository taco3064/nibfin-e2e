import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { indexPlatforms, predicateTypes } from '../../scenarios/image-provenance.ts';
import { Checks, excerpt, freeOfSecrets, redact, redactDeep } from '../../scenarios/lib/checks.ts';
import { parseEvent, project, watchJobContainers } from '../../scenarios/lib/containers.ts';
import { buildOutput, causeCodes, imageLine, initEvents, jobLog, stageJob } from '../../scenarios/lib/joblog.ts';
import { PROBE_SCRIPT, parseProbe } from '../../scenarios/lib/probe.ts';
import { editRunnerEnv, runnerDir, withEnvLine } from '../../scenarios/lib/runner-env.ts';
import { loginFacts } from '../../scenarios/lib/volume.ts';
import { EXEC, setup } from './kit.ts';

const TOKEN = 'nibfin-token-value-123';

test('the inspect projection keeps only allowlisted fields and the two run ids', () => {
  const raw = [{
    ImageName: 'ghcr.io/taco3064/nibfin@sha256:abc',
    HostConfig: { Memory: 3221225472, NanoCpus: 2e9, CpuQuota: 0, PidsLimit: 2048, Binds: ['x'] },
    Config: { Env: ['NIBFIN_GITHUB_TOKEN=' + TOKEN, 'NIBFIN_RUN_ID=42', 'NIBFIN_RUN_REPO=o/exec', 'PATH=/bin'] },
    Mounts: [{ Name: 'nibfin-home-claude', Source: '/home/u/.local/share/containers/storage/volumes/nibfin-home-claude/_data', Destination: '/home/nibfin' }],
  }];
  const p = project(raw);
  deepEqual(p, {
    imageName: 'ghcr.io/taco3064/nibfin@sha256:abc',
    memory: 3221225472,
    nanoCpus: 2e9,
    cpuQuota: 0,
    pidsLimit: 2048,
    mounts: [{ source: '/home/u/.local/share/containers/storage/volumes/nibfin-home-claude/_data', destination: '/home/nibfin' }],
    runId: '42',
    runRepo: 'o/exec',
  });
  equal(JSON.stringify(p).includes(TOKEN), false);
  equal(project([]), undefined);
});

test('the events parser keeps start and died only', () => {
  deepEqual(parseEvent('{"ID":"abc","Status":"start","Type":"container"}'), { kind: 'start', id: 'abc' });
  deepEqual(parseEvent('{"ID":"abc","Status":"died"}'), { kind: 'died', id: 'abc' });
  equal(parseEvent('{"ID":"abc","Status":"create"}'), undefined);
  equal(parseEvent('not json'), undefined);
});

test('a watch inspects on start, keeps the projection, counts died events and fails at the deadline naming the stage', async () => {
  const inspectOut = JSON.stringify([{ ImageName: 'img', HostConfig: { Memory: 1 }, Config: { Env: ['NIBFIN_RUN_ID=7', 'NIBFIN_GITHUB_TOKEN=' + TOKEN] } }]);
  const h = setup({ respond: (argv) => (argv[1] === 'container' && argv[2] === 'inspect' ? { stdout: inspectOut } : undefined) });
  const starts: number[] = [];
  const w = watchJobContainers(h.kit, EXEC, 9, (_e, i) => void starts.push(i));
  deepEqual(h.events.argvs[0]?.slice(0, 6), ['podman', 'events', '--format', 'json', '--since', '10s']);
  ok(h.events.argvs[0]?.includes('label=io.github.taco3064.nibfin.issue=9'));
  h.events.emit('{"ID":"c1","Status":"start"}');
  const s = await w.started(1, 1000, 'Shape');
  equal((await w.projection(s.id))?.runId, '7');
  h.events.emit('{"ID":"c1","Status":"died"}');
  await w.died(1, 1000, 'Shape');
  deepEqual(starts, [0]);
  await rejects(w.died(2, 20, 'the Deliver Job container of o/exec#9 to end'), /timed out after 0 s waiting for the Deliver Job container of o\/exec#9 to end/);
  w.stop();
  await rejects(w.died(2, 1000, 'Review'), /the watch was stopped while waiting for Review/);
  equal(h.logs.join('\n').includes(TOKEN), false);
});

test('init events, the image line, build output and cause codes are read from a Job log', () => {
  const log = [
    '2026-11-26T10:00:00.0000000Z Nibfin image: ghcr.io/taco3064/nibfin@sha256:abc',
    '2026-11-26T10:00:01.0000000Z {"type":"system","subtype":"init","model":"claude-opus-4-5","mcp_servers":[{"name":"e2e-probe","status":"connected"}]}',
    '2026-11-26T10:00:02.0000000Z {"type":"assistant","message":"init"}',
    '2026-11-26T10:00:03.0000000Z error TOOL_INSTALL_FAILED: uv python install exited 2',
  ].join('\n');
  deepEqual(initEvents(log), [{ model: 'claude-opus-4-5', mcpServers: [{ name: 'e2e-probe', status: 'connected' }] }]);
  equal(imageLine(log), 'ghcr.io/taco3064/nibfin@sha256:abc');
  equal(buildOutput(log), undefined);
  equal(buildOutput('STEP 1/3: FROM x'), 'STEP 1/3');
  deepEqual(causeCodes(log), ['TOOL_INSTALL_FAILED']);
  deepEqual(causeCodes('Not a CODE, nor A_, but CONFIG_INVALID and E2E_X'), ['CONFIG_INVALID', 'E2E_X']);
});

test('the stage Job is the one on a local Runner; its runner_name maps to a slot, and an unmatched set fails naming every Job', async () => {
  const h = setup();
  const jobs = [
    { id: 1, name: 'route', runner_name: 'GitHub Actions 12', status: 'completed' },
    { id: 2, name: 'stage', runner_name: 'myhost-1a2b3c4d-claude-2', status: 'completed' },
  ];
  const original = h.fake.fetch;
  let logAuth: string | null = 'unset';
  let logBody = 'the log\n';
  h.kit.github = (await import('../../src/host/github.ts')).createGitHub(() => 'tok', async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/runs/42/jobs')) return new Response(JSON.stringify({ total_count: jobs.length, jobs }), { status: 200 });
    if (url.pathname.endsWith('/jobs/2/logs')) return new Response(null, { status: 302, headers: { Location: 'https://logs.example/x' } });
    if (url.host === 'logs.example') return ((logAuth = new Headers(init?.headers).get('authorization')), new Response(logBody));
    return original(input, init);
  });
  deepEqual(await stageJob(h.kit, EXEC, '42'), { id: 2, name: 'stage', runnerName: 'myhost-1a2b3c4d-claude-2', slot: 'claude-2', status: 'completed' });
  const work = mkdtempSync(join(tmpdir(), 'e2e-joblog-'));
  const got = await jobLog({ ...h.kit, workDir: work }, EXEC, '42', 'case-1');
  equal(got.text, 'the log\n');
  equal(logAuth, null);
  equal(readFileSync(join(work, 'logs', 'case-1.log'), 'utf8'), 'the log\n');
  equal(got.secretFound, false);
  // A secret in the log is reported and never saved.
  logBody = 'leaked claude-token-value here\n';
  const leaked = await jobLog({ ...h.kit, workDir: work }, EXEC, '42', 'case-2');
  equal(leaked.secretFound, true);
  equal(readFileSync(join(work, 'logs', 'case-2.log'), 'utf8').includes('claude-token-value'), false);
  jobs[1] = { ...jobs[1], runner_name: 'otherhost-claude' } as (typeof jobs)[number];
  const err = await stageJob(h.kit, EXEC, '42').catch((e: Error) => e.message);
  match(String(err), /expected one Job on a local Runner .*saw route on GitHub Actions 12, stage on otherhost-claude/);
});

test('the probe script prints no environment value but the memory switch, and the last block is parsed', () => {
  equal(/\$\{?(NIBFIN|GH|GITHUB|CLAUDE_CODE_OAUTH)/.test(PROBE_SCRIPT), false);
  const text = 'Shape\n```e2e-probe\nuid=1\n```\nlater\n```e2e-probe\nuid=1000\nancestor=sh\nancestor=claude\nexists:CLAUDE.md=yes\nfirst_instruction_line=# Shape\n```\n';
  const p = parseProbe(text);
  deepEqual(p?.get('uid'), ['1000']);
  deepEqual(p?.get('ancestor'), ['sh', 'claude']);
  deepEqual(p?.get('first_instruction_line'), ['# Shape']);
  equal(parseProbe('no block here'), undefined);
});

test('the login settings reader returns derived values, never the token', () => {
  const f = loginFacts({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, enableAllProjectMcpServers: true, sandbox: { enabled: false } });
  deepEqual(f, { exists: true, hasToken: true, enableAllProjectMcpServers: true, sandboxEnabled: false, keys: ['enableAllProjectMcpServers', 'env', 'sandbox'] });
  equal(JSON.stringify(f).includes(TOKEN), false);
  deepEqual(loginFacts(undefined).exists, false);
});

test('the Runner .env edit keeps other lines and is idempotent', () => {
  equal(withEnvLine('A=1\nB=2\n', 'NIBFIN_MODEL', 'sonnet'), 'A=1\nB=2\nNIBFIN_MODEL=sonnet\n');
  equal(withEnvLine(withEnvLine('A=1\nNIBFIN_MODEL=opus\n', 'NIBFIN_MODEL', 'sonnet'), 'NIBFIN_MODEL', 'sonnet'), 'A=1\nNIBFIN_MODEL=sonnet\n');
  equal(withEnvLine('A=1\nNIBFIN_MODEL=sonnet\n', 'NIBFIN_MODEL', undefined), 'A=1\n');
  equal(withEnvLine('A=1\n', 'NIBFIN_MODEL', undefined), 'A=1\n');
  const data = mkdtempSync(join(tmpdir(), 'e2e-runner-'));
  const env = { XDG_DATA_HOME: data };
  equal(runnerDir(env, 'claude-1'), join(data, 'nibfin', 'runners', 'claude-1'));
  equal(runnerDir({ HOME: '/home/u' }, 'claude-1'), join('/home/u', '.local', 'share', 'nibfin', 'runners', 'claude-1'));
  mkdirSync(runnerDir(env, 'claude-1'), { recursive: true });
  writeFileSync(join(runnerDir(env, 'claude-1'), '.env'), 'LANG=C.UTF-8\n');
  editRunnerEnv(env, 'claude-1', 'NIBFIN_MODEL', 'sonnet');
  editRunnerEnv(env, 'claude-1', 'NIBFIN_MODEL', 'sonnet');
  equal(readFileSync(join(runnerDir(env, 'claude-1'), '.env'), 'utf8'), 'LANG=C.UTF-8\nNIBFIN_MODEL=sonnet\n');
});

test('index platforms ignore attestation entries; predicate types come from the DSSE payloads', () => {
  const index = { manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }, { platform: { os: 'linux', architecture: 'arm64' } }, { platform: { os: 'unknown', architecture: 'unknown' } }] };
  deepEqual(indexPlatforms(index), ['linux/amd64', 'linux/arm64']);
  deepEqual(indexPlatforms({}), []);
  const payload = Buffer.from(JSON.stringify({ predicateType: 'https://slsa.dev/provenance/v1' })).toString('base64');
  deepEqual(predicateTypes({ attestations: [{ bundle: { dsseEnvelope: { payload } } }, { bundle: {} }] }), ['https://slsa.dev/provenance/v1']);
});

test('secret absence is checked in memory', () => {
  equal(freeOfSecrets('a log with *** only', [TOKEN]), true);
  equal(freeOfSecrets(`leaked ${TOKEN}`, [TOKEN]), false);
});

test('redact, excerpt and Checks remove secret values from every printed detail', () => {
  const secret = 'abcdefgh-secret';
  equal(redact(`x ${secret} y ${secret}`, [secret]), 'x [secret value removed by nibfin-e2e] y [secret value removed by nibfin-e2e]');
  equal(redact('short abc kept', ['abc']), 'short abc kept');
  // Redacted before cutting, so no prefix of the value survives a cut through it.
  equal(excerpt(`0123 ${secret}`, 9, [secret]), '0123 [sec');
  equal(excerpt(`0123 ${secret}`, 9, [secret]).includes('abcd'), false);
  const c = new Checks([secret]);
  c.hold('R1.14', 'held', true, `saw ${secret}`);
  const passed = c.outcome(`prefix ${secret}: `);
  equal(passed.status, 'passed');
  equal(passed.reason.includes(secret), false);
  c.hold('R1.14', 'failed', false, `saw ${secret}`);
  const failed = c.outcome();
  equal(failed.status, 'failed');
  equal(failed.reason.includes(secret), false);
  equal(c.failed.join('').includes(secret), false);
});

test('redactDeep redacts every string, key and nested value, and leaves other values', () => {
  const secret = 'deep-secret-value';
  const out = redactDeep({ a: [`x${secret}`, 1, null], [secret]: { b: secret, c: true } }, [secret]);
  deepEqual(out, { a: ['x[secret value removed by nibfin-e2e]', 1, null], '[secret value removed by nibfin-e2e]': { b: '[secret value removed by nibfin-e2e]', c: true } });
});
