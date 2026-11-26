import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub } from '../../src/host/github.ts';
import type { Exec } from '../../src/host/exec.ts';
import { createHostOperations, parseUnits } from '../../src/host/operations.ts';
import type { HostServices } from '../../src/host/services.ts';
import { fakeExec } from './fakes.ts';

function services(exec: Exec, env: Record<string, string | undefined> = { E2E_SANDBOX_TOKEN: 'sbx-token', E2E_CLAUDE_TOKEN: 'claude-token' }, fetchFn?: typeof fetch): HostServices {
  return {
    env,
    exec,
    fetch: fetchFn ?? fetch,
    github: createGitHub(() => 'sbx-token', fetchFn),
    repoRoot: '/tmp/none',
    workDir: () => '/tmp/none',
    sandboxToken: () => 'sbx-token',
  };
}

/** A login volume helper fake: remembers what was written on stdin and reads it back. */
function volume() {
  let written = '';
  const fake = fakeExec((argv, o) => {
    const script = argv.at(-1) ?? '';
    if (script.startsWith('umask')) return ((written = o.input ?? ''), {});
    if (script.startsWith('stat')) return { stdout: written ? `0 755\n0 600\n${written}` : '0 755\n-\n' };
    return undefined;
  });
  return { ...fake, written: () => written };
}

test('claudeLogin writes an invalid then the valid token on stdin only, and never touches the podman machine on Linux', async () => {
  const v = volume();
  const ops = createHostOperations(services(v.exec), 'linux');
  const out = await ops.claudeLogin('invalid');
  const invalid = (JSON.parse(v.written()) as { env: { CLAUDE_CODE_OAUTH_TOKEN: string } }).env.CLAUDE_CODE_OAUTH_TOKEN;
  match(invalid, /^e2e-invalid-[0-9a-f]{24}$/);
  equal(out.includes(invalid), false);
  await ops.claudeLogin('valid');
  equal((JSON.parse(v.written()) as { env: { CLAUDE_CODE_OAUTH_TOKEN: string } }).env.CLAUDE_CODE_OAUTH_TOKEN, 'claude-token');
  equal(v.calls.some((c) => c.argv.join(' ').includes('claude-token') || c.argv.join(' ').includes(invalid)), false);
  equal(v.calls.some((c) => c.argv.includes('machine')), false);
});

test('host operations refuse other platforms', async () => {
  const ops = createHostOperations(services(fakeExec().exec), 'win32');
  await rejects(ops.claudeLogin('valid'), /not supported on win32/);
  await rejects(ops.runnerServices('stop'), /not supported on win32/);
  await rejects(ops.stopJobContainers('o/r', 1), /not supported on win32/);
});

test('parseUnits keeps only Runner unit names', () => {
  deepEqual(parseUnits('nibfin-runner-claude-1.service loaded active running X\nnibfin-runner-claude-2.service loaded inactive dead Y\n\nother.service x\n'), [
    'nibfin-runner-claude-1.service',
    'nibfin-runner-claude-2.service',
  ]);
});

test('runnerServices lists the units, stops each by name and reads each back', async () => {
  const state = new Map([['nibfin-runner-claude-1.service', 'active'], ['nibfin-runner-claude-2.service', 'active']]);
  const env: Record<string, string | undefined> = {};
  const { exec, calls } = fakeExec((argv) => {
    const [, , verb, unit = ''] = argv;
    if (verb === 'list-units') return { stdout: [...state.keys()].map((u) => `${u} loaded active running Runner`).join('\n') };
    if (verb === 'stop') return (state.set(unit, 'inactive'), {});
    if (verb === 'start') return (state.set(unit, 'active'), {});
    if (verb === 'is-active') return { stdout: `${state.get(unit)}\n`, code: state.get(unit) === 'active' ? 0 : 3 };
    return undefined;
  });
  const ops = createHostOperations(services(exec, env), 'linux');
  deepEqual(await ops.runnerServices('stop'), [...state.keys()]);
  deepEqual(calls[0]?.argv, ['systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend', 'nibfin-runner-claude-*.service']);
  deepEqual(calls.slice(1, 3).map((c) => c.argv.slice(2)), [['stop', 'nibfin-runner-claude-1.service'], ['stop', 'nibfin-runner-claude-2.service']]);
  equal([...state.values()].every((s) => s === 'inactive'), true);
  match(String(env.XDG_RUNTIME_DIR), /^\/run\/user\/\d+$/);
  await ops.runnerServices('start');
  equal([...state.values()].every((s) => s === 'active'), true);
  equal(calls.every((c) => c.options.ghToken === undefined), true);
});

test('runnerServices fails when a unit does not read back, and when no unit is loaded', async () => {
  const stuck = fakeExec((argv) => {
    if (argv[2] === 'list-units') return { stdout: 'nibfin-runner-claude-1.service loaded active running R\n' };
    if (argv[2] === 'is-active') return { stdout: 'active\n' };
    return undefined;
  });
  await rejects(createHostOperations(services(stuck.exec, {}), 'linux').runnerServices('stop'), /nibfin-runner-claude-1.service is active/);
  const none = fakeExec(() => ({ stdout: '' }));
  await rejects(createHostOperations(services(none.exec, {}), 'linux').runnerServices('start'), /no nibfin-runner-claude-\*.service unit/);
});

test('stopJobContainers stops only the Issue\'s containers of that repository and reads back none is left', async () => {
  let running = [
    { Id: 'c1', Labels: { 'io.github.taco3064.nibfin.repo': 'o/r', 'io.github.taco3064.nibfin.issue': '7' } },
    { Id: 'c2', Labels: { 'io.github.taco3064.nibfin.repo': 'o/other', 'io.github.taco3064.nibfin.issue': '7' } },
  ];
  const { exec, calls } = fakeExec((argv) => {
    if (argv[1] === 'ps') return { stdout: JSON.stringify(running) };
    if (argv[1] === 'stop') return ((running = running.filter((c) => c.Id !== argv.at(-1))), {});
    return undefined;
  });
  equal(await createHostOperations(services(exec), 'linux').stopJobContainers('o/r', 7), 1);
  deepEqual(calls[0]?.argv, ['podman', 'ps', '--filter', 'label=io.github.taco3064.nibfin.issue=7', '--format', 'json']);
  deepEqual(calls[1]?.argv, ['podman', 'stop', '--time', '0', 'c1']);
  deepEqual(running.map((c) => c.Id), ['c2']);
});

test('stopJobContainers fails when a container survives', async () => {
  const { exec } = fakeExec((argv) => (argv[1] === 'ps' ? { stdout: JSON.stringify([{ Id: 'c1', Labels: { 'io.github.taco3064.nibfin.repo': 'r', 'io.github.taco3064.nibfin.issue': '3' } }]) } : undefined));
  await rejects(createHostOperations(services(exec), 'linux').stopJobContainers('o/r', 3), /still running/);
});

test('secretValues returns the set tokens; ownerLogin and ownerId read GET /user once', async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => (calls++, new Response(JSON.stringify({ login: 'owner', id: 42 }), { status: 200 }));
  const ops = createHostOperations(services(fakeExec().exec, { E2E_SANDBOX_TOKEN: 'a', E2E_CLAUDE_TOKEN: ' ' }, fetchFn), 'linux');
  deepEqual(ops.secretValues(), ['a']);
  deepEqual([await ops.ownerLogin(), await ops.ownerId(), calls], ['owner', 42, 1]);
});
