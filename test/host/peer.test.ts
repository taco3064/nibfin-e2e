import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { requireEnv } from '../../src/host/config.ts';
import { createExec } from '../../src/host/exec.ts';
import type { GitHub } from '../../src/host/github.ts';
import { deletePeerKeys, freeRange, peerArgv, preparePeer, teardownPeer } from '../../src/host/peer.ts';
import type { PeerFacts } from '../../src/host/peer.ts';
import type { HostServices } from '../../src/host/services.ts';
import { fakeExec, fakeRunning } from './fakes.ts';

type Handler = (method: string, path: string, body: unknown) => { status: number; data?: unknown } | undefined;

/** A GitHub stub that records every call; `list` unwraps `key`. */
export function stubGitHub(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const answer = (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const r = handler(method, path, body);
    if (!r) throw new Error(`stub: no route ${method} ${path}`);
    return r;
  };
  const gh: GitHub = {
    async rest<T>(method: string, path: string, body?: unknown, allow: number[] = []) {
      const r = answer(method, path, body);
      if (r.status >= 400 && !allow.includes(r.status))
        throw new Error(`GitHub ${method} ${path} returned ${r.status}`);
      return { status: r.status, data: r.data as T };
    },
    async list<T>(path: string, key?: string) {
      const r = answer('GET', path);
      return (key ? (r.data as Record<string, T[]>)[key] : r.data) as T[];
    },
    async listByLink<T>(path: string) {
      return answer('GET', path).data as T[];
    },
    graphql: async () => {
      throw new Error('stub: no GraphQL');
    },
    download: async (path) => ({ status: 200, text: String(answer('GET', path).data) }),
  };
  return { gh, calls };
}

const INNER = 10;
const inner = (argv: string[]) =>
  argv[0] === 'sudo' && argv[1] === '-u' && argv[5] === '/bin/sh' ? argv.slice(INNER) : undefined;

test('peerArgv runs as e2epeer through sudo and passes the token only as the first stdin line', () => {
  const p = peerArgv(['gh', 'nibfin', 'status'], { cwd: '/home/e2epeer/sandbox', token: 'peer-secret', input: 'rest' });
  deepEqual(p.argv.slice(0, 7), ['sudo', '-u', 'e2epeer', '-H', '--', '/bin/sh', '-c']);
  deepEqual(p.argv.slice(8), ['sh', '/home/e2epeer/sandbox', 'gh', 'nibfin', 'status']);
  equal(
    p.argv.some((a) => a.includes('peer-secret')),
    false,
  );
  equal(p.input, 'peer-secret\nrest');
  equal(peerArgv(['id']).input, '');
  equal(peerArgv(['id']).argv[2], 'e2epeer');
});

test('the peer prelude exports GH_TOKEN from stdin, keeps the rest of stdin, and the child gets no E2E_* variable', async () => {
  const exec = createExec({ ...process.env, E2E_PEER_GITHUB_TOKEN: 'peer-secret', E2E_SANDBOX_TOKEN: 'sbx' }, () => {});
  const script =
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({s,cwd:process.cwd(),gh:process.env.GH_TOKEN,e2e:Object.keys(process.env).filter(k=>/^E2E_/i.test(k)),rt:process.env.XDG_RUNTIME_DIR})))';
  const p = peerArgv([process.execPath, '-e', script], { cwd: '/tmp', token: 'peer-secret', input: 'more input' });
  // Without sudo: the same /bin/sh script and positional arguments.
  const r = await exec(p.argv.slice(5), { input: p.input });
  const out = JSON.parse(r.stdout);
  equal(out.s, 'more input');
  equal(out.gh, 'peer-secret');
  equal(out.cwd, '/tmp');
  deepEqual(out.e2e, []);
  match(out.rt, /^\/run\/user\/\d+$/);
  const none = peerArgv([process.execPath, '-e', script], { cwd: '/tmp' });
  equal(JSON.parse((await exec(none.argv.slice(5), { input: none.input })).stdout).gh, undefined);
});

test('the peer prelude points the XDG folders at the peer home and unsets GH_CONFIG_DIR, whatever reached it', async () => {
  const home = '/tmp/nibfin-peer-home';
  const exec = createExec(
    {
      ...process.env,
      HOME: home,
      E2E_PEER_GITHUB_TOKEN: 'peer-secret',
      XDG_CONFIG_HOME: '/home/runner/.config',
      XDG_DATA_HOME: '/home/runner/.local/share',
      XDG_CACHE_HOME: '/home/runner/.cache',
      XDG_STATE_HOME: '/home/runner/.local/state',
      GH_CONFIG_DIR: '/home/runner/.config/gh',
    },
    () => {},
  );
  const script =
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=process.env;console.log(JSON.stringify({s,cwd:process.cwd(),gh:e.GH_TOKEN,e2e:Object.keys(e).filter(k=>/^E2E_/i.test(k)),rt:e.XDG_RUNTIME_DIR,home:e.HOME,config:e.XDG_CONFIG_HOME,data:e.XDG_DATA_HOME,cache:e.XDG_CACHE_HOME,state:e.XDG_STATE_HOME,ghConfig:e.GH_CONFIG_DIR}))})';
  for (const token of ['peer-secret', undefined]) {
    const p = peerArgv([process.execPath, '-e', script], { cwd: '/tmp', token, input: 'more input' });
    // Without sudo: the same /bin/sh script and positional arguments.
    const out = JSON.parse((await exec(p.argv.slice(5), { input: p.input })).stdout);
    equal(out.home, home);
    equal(out.config, join(home, '.config'));
    equal(out.data, join(home, '.local', 'share'));
    equal(out.cache, join(home, '.cache'));
    equal(out.state, join(home, '.local', 'state'));
    equal(out.ghConfig, undefined);
    equal(out.s, 'more input');
    equal(out.gh, token);
    equal(out.cwd, '/tmp');
    deepEqual(out.e2e, []);
    match(out.rt, /^\/run\/user\/\d+$/);
  }
});

test('freeRange starts after every used range and at least at 100000', () => {
  deepEqual(freeRange(''), { start: 100000, end: 165535 });
  deepEqual(freeRange('runner:100000:65536\nother:231072:65536\n'), { start: 296608, end: 362143 });
});

test('deletePeerKeys deletes only the harness prefix and reports what reads back', async () => {
  let keys = [
    { id: 1, title: 'nibfin-e2e-peer-old', key: 'ssh-ed25519 A' },
    { id: 2, title: 'laptop', key: 'ssh-ed25519 B' },
  ];
  const stuck = new Set<number>();
  const { gh, calls } = stubGitHub((method, path) => {
    if (method === 'GET' && path === '/user/keys') return { status: 200, data: keys };
    const id = Number(/^\/user\/keys\/(\d+)$/.exec(path)?.[1]);
    if (method === 'DELETE' && id) {
      if (!stuck.has(id)) keys = keys.filter((k) => k.id !== id);
      return { status: 204 };
    }
    return undefined;
  });
  deepEqual(await deletePeerKeys(gh), []);
  deepEqual(
    calls.filter((c) => c.method === 'DELETE').map((c) => c.path),
    ['/user/keys/1'],
  );
  deepEqual(
    keys.map((k) => k.title),
    ['laptop'],
  );
  keys.push({ id: 3, title: 'nibfin-e2e-peer-new', key: 'ssh-ed25519 C' });
  stuck.add(3);
  deepEqual(await deletePeerKeys(gh), ['nibfin-e2e-peer-new (3)']);
});

interface World {
  permission: string;
  keys: { id: number; title: string; key: string }[];
}

function services(
  world: World,
  env: Record<string, string> = {
    E2E_SANDBOX_TOKEN: 's',
    E2E_CLAUDE_TOKEN: 'claude-secret',
    E2E_PEER_GITHUB_TOKEN: 'peer-secret',
  },
) {
  let userExists = false;
  let written = false;
  const { exec, calls } = fakeExec((argv: string[]) => {
    const cmd = inner(argv);
    if (cmd) {
      if (cmd[0] === 'cat' && cmd[2]?.endsWith('.pub')) return { stdout: 'ssh-ed25519 AAAAPUB nibfin-e2e-peer\n' };
      if (cmd[0] === 'podman' && cmd.includes('-i')) {
        written = true;
        return {};
      }
      if (cmd[0] === 'podman' && cmd[1] === 'run') {
        return {
          stdout: written
            ? `0 700\n0 600\n${JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret' } })}\n`
            : '0 700\n-\n',
        };
      }
      if (cmd.join(' ') === 'gh extension remove nibfin') return { code: 1 };
      return {};
    }
    const line = argv.join(' ');
    if (line === 'id -u e2epeer') return userExists ? { stdout: '1001\n' } : { code: 1 };
    if (line.startsWith('sudo useradd')) userExists = true;
    if (line === 'cat /etc/subuid') return { stdout: 'runner:100000:65536\n' };
    if (line === 'cat /etc/subgid') return { stdout: 'runner:100000:65536\ne2epeer:165536:65536\n' };
    if (line === 'getent passwd e2epeer') return { stdout: 'e2epeer:x:1001:1001::/home/e2epeer:/bin/bash\n' };
    return {};
  });
  const peer = stubGitHub((method, path, body) => {
    if (path === '/user') return { status: 200, data: { login: 'peer-login', id: 4242 } };
    if (method === 'GET' && path === '/user/keys') return { status: 200, data: world.keys };
    if (method === 'POST' && path === '/user/keys') {
      const k = { id: 77, ...(body as { title: string; key: string }) };
      world.keys.push(k);
      return { status: 201, data: k };
    }
    const id = Number(/^\/user\/keys\/(\d+)$/.exec(path)?.[1]);
    if (method === 'GET' && id) return { status: 200, data: world.keys.find((k) => k.id === id) };
    if (method === 'DELETE' && id) {
      world.keys = world.keys.filter((k) => k.id !== id);
      return { status: 204 };
    }
    return undefined;
  });
  const sandbox = stubGitHub((method, path) => {
    if (path === '/repos/taco3064/nibfin-e2e-sandbox/collaborators/peer-login/permission') {
      return world.permission === 'missing' ? { status: 404 } : { status: 200, data: { permission: world.permission } };
    }
    return undefined;
  });
  const host: HostServices = {
    env,
    exec,
    fetch,
    github: sandbox.gh,
    repoRoot: '/tmp/none',
    workDir: () => '/tmp/none/.e2e-work',
    sandboxToken: () => 's',
    peerGithub: peer.gh,
    peerToken: () => 'peer-secret',
    start: () => fakeRunning(),
  };
  return { host, calls, peer, sandbox };
}

test('preparePeer: user, ids, user manager, gh-nibfin, clone, login volume and a fresh SSH key; tokens never in argv', async () => {
  const world: World = {
    permission: 'write',
    keys: [
      { id: 5, title: 'nibfin-e2e-peer-crashed', key: 'ssh-ed25519 OLD' },
      { id: 6, title: 'laptop', key: 'ssh-ed25519 L' },
    ],
  };
  const s = services(world);
  const facts: PeerFacts = {};
  const reason = await preparePeer(s.host, 'linux', facts, () => new Date('2026-11-26T10:00:00.000Z'));
  match(reason, /peer-login \(write\) has SSH key nibfin-e2e-peer-2026-11-26T10-00-00-000Z/);
  deepEqual(facts, {
    login: 'peer-login',
    id: 4242,
    home: '/home/e2epeer',
    userReady: true,
    installed: true,
    cloned: true,
    keyId: 77,
  });
  const lines = s.calls.map((c) =>
    inner(c.argv) ? `peer: ${(inner(c.argv) as string[]).join(' ')}` : c.argv.join(' '),
  );
  const order = [
    'sudo useradd -m -s /bin/bash e2epeer',
    'sudo usermod --add-subuids 165536-231071 e2epeer',
    'sudo loginctl enable-linger e2epeer',
    'sudo systemctl start user@1001.service',
    'sudo install -o e2epeer -g e2epeer -m 0755 /tmp/none/.e2e-work/gh-nibfin/gh-nibfin /home/e2epeer/gh-nibfin/gh-nibfin',
    'peer: gh extension install .',
    'peer: gh nibfin --help',
    'peer: git clone --quiet https://github.com/taco3064/nibfin-e2e-sandbox.git /home/e2epeer/sandbox',
    'peer: ssh-keygen -q -t ed25519 -N  -C nibfin-e2e-peer -f /home/e2epeer/.ssh/id_ed25519',
  ];
  let at = -1;
  for (const o of order) {
    const i = lines.indexOf(o);
    equal(i > at, true, `${o} after the previous step (got ${i}): ${lines.join('\n')}`);
    at = i;
  }
  equal(
    lines.some((l) => l.includes('--add-subgids')),
    false,
    'an existing subgid range is kept',
  );
  for (const c of s.calls) {
    equal(
      c.argv.some((a) => /peer-secret|claude-secret/.test(a)),
      false,
      `secret in argv: ${c.argv.join(' ')}`,
    );
  }
  const tokenRuns = s.calls
    .filter((c) => c.options.input?.startsWith('peer-secret\n'))
    .map((c) => (inner(c.argv) as string[]).slice(0, 2).join(' '));
  deepEqual(tokenRuns, ['gh extension', 'gh extension', 'gh nibfin']);
  equal(
    s.calls.some((c) => c.options.input?.includes('claude-secret') && inner(c.argv)?.[0] === 'podman'),
    true,
  );
  deepEqual(
    world.keys.map((k) => k.title),
    ['laptop', 'nibfin-e2e-peer-2026-11-26T10-00-00-000Z'],
  );
  deepEqual(s.peer.calls.find((c) => c.method === 'POST')?.body, {
    title: 'nibfin-e2e-peer-2026-11-26T10-00-00-000Z',
    key: 'ssh-ed25519 AAAAPUB',
  });
  equal(s.host.peer?.keyId, 77);
  equal(s.host.peer?.dir, '/home/e2epeer/sandbox');
  await rejects(s.host.peer?.readPublic('/home/e2epeer/.ssh/id_ed25519') as Promise<string>, /only public key files/);
});

test('preparePeer: admin, read and no permission fail before any host change; other platforms are refused', async () => {
  for (const [permission, why] of [
    ['admin', /must be a write collaborator, not admin/],
    ['read', /has read permission.*Issue #281/],
    ['missing', /has none permission.*Issue #281/],
  ] as const) {
    const s = services({ permission, keys: [] });
    await rejects(preparePeer(s.host, 'linux', {}), why);
    deepEqual(s.calls, []);
  }
  const s = services({ permission: 'write', keys: [] });
  await rejects(preparePeer(s.host, 'windows', {}), /collaborator scenarios are Linux-only/);
  deepEqual(s.peer.calls, []);
});

test('preparePeer: a missing peer token fails naming the variable', async () => {
  const s = services({ permission: 'write', keys: [] });
  const env = { E2E_CLAUDE_TOKEN: 'c' };
  const host: HostServices = { ...s.host, env, peerToken: () => requireEnv(env, 'E2E_PEER_GITHUB_TOKEN') };
  await rejects(preparePeer(host, 'linux', {}), /missing environment variable E2E_PEER_GITHUB_TOKEN/);
  deepEqual(s.calls, []);
});

test('teardownPeer: no_runners counts as passed, keys are deleted and read back; a leftover is reported', async () => {
  const world: World = { permission: 'write', keys: [{ id: 9, title: 'nibfin-e2e-peer-x', key: 'ssh-ed25519 X' }] };
  const s = services(world);
  const { exec, calls } = fakeExec((argv) =>
    inner(argv)?.[0] === 'gh' ? { code: 1, stderr: 'no_runners: no claude Runner on this host' } : undefined,
  );
  const host = { ...s.host, exec };
  deepEqual(
    await teardownPeer(host, { login: 'peer-login', installed: true, cloned: true, home: '/home/e2epeer' }),
    [],
  );
  deepEqual(inner(calls[0]?.argv ?? []), ['gh', 'nibfin', 'runner', 'remove', 'claude', '--yes']);
  equal(calls[0]?.argv[9], '/home/e2epeer/sandbox');
  await teardownPeer(host, { login: 'peer-login', installed: true, home: '/home/e2epeer' });
  equal(calls.at(-1)?.argv[9], '/home/e2epeer', 'without a clone the removal runs in the home directory');
  equal(world.keys.length, 0);

  const failing = fakeExec((argv) => (inner(argv)?.[0] === 'gh' ? { code: 1, stderr: 'runner_busy' } : undefined));
  world.keys.push({ id: 10, title: 'nibfin-e2e-peer-y', key: 'ssh-ed25519 Y' });
  const stuck = stubGitHub((method, path) =>
    method === 'GET' && path === '/user/keys' ? { status: 200, data: world.keys } : { status: 204 },
  );
  const problems = await teardownPeer(
    { ...s.host, exec: failing.exec, peerGithub: stuck.gh },
    { login: 'peer-login', installed: true, cloned: true, home: '/home/e2epeer' },
  );
  match(
    problems.join('; '),
    /runner remove claude --yes exited 1: runner_busy; SSH keys left on peer-login: nibfin-e2e-peer-y \(10\)/,
  );
  deepEqual(await teardownPeer(s.host, undefined), []);
});
