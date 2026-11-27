import { deepEqual, equal, match, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIni, parseUnitFiles, readLinuxHostState, userEnabledUnits, userRuntimeDir } from '../../src/host/hoststate.ts';
import type { HostRun } from '../../src/host/hoststate.ts';
import { Check, precondition, redact, tail } from '../../scenarios/lib/check.ts';
import { isNibfinRunFor, leafCommands, parseHelp, parseRemaining } from '../../scenarios/lib/gh.ts';
import { mainDigest, requireCurrentImage } from '../../scenarios/lib/image.ts';
import { schemaValidator } from '../../scenarios/lib/schema.ts';
import { waitFor } from '../../scenarios/lib/wait.ts';
import { guideTail, GUIDE_LINE, loginGuide, statusRunners, SUCCESS_LINE, waitForOutput } from '../../scenarios/management/login-guide.ts';
import { claudeLoggedIn, providerLogin } from '../../scenarios/dashboard/support.ts';
import { readWorkflow } from '../../scenarios/lib/workflows.ts';

const D1 = 'sha256:' + '1'.repeat(64);
const D2 = 'sha256:' + '2'.repeat(64);

test('workflow reads: top-level name and run-name, uses, image references and runs-on', () => {
  const w = readWorkflow(`name: "Nibfin · Issue"
run-name: Nibfin · \${{ github.event.issue.number }}
on: issues
jobs:
  a:
    name: not the top-level name
    runs-on: [self-hosted, nibfin-42]
    steps:
      - uses: actions/checkout@abc
      - run: podman run ghcr.io/taco3064/nibfin@${D1} core
  b:
    runs-on:
      group: x
      labels:
        - nibfin-\${{ vars.ID }}
    steps:
      -   uses: 'taco3064/thing@main'
`);
  equal(w.name, 'Nibfin · Issue');
  equal(w.runName, 'Nibfin · ${{ github.event.issue.number }}');
  deepEqual(w.uses, ['actions/checkout@abc', 'taco3064/thing@main']);
  deepEqual(w.images, [`ghcr.io/taco3064/nibfin@${D1}`]);
  deepEqual(w.runsOn, ['[self-hosted, nibfin-42]', 'group: x labels: - nibfin-${{ vars.ID }}']);
  deepEqual(readWorkflow('on: push\n'), { uses: [], images: [], runsOn: [] });
});

const HELP = `Add Runners

Usage:
  gh nibfin runner add <claude|codex> [flags]

Flags:
      --count int     number of Runners (default 2)
  -h, --help          help for add
  -R, --repo string   repository (default "o/r")
      --yes           skip the confirmation

Global Flags:
      --verbose   more output
`;

test('help parsing: subcommands without cobra builtins, flags with defaults, without help', () => {
  deepEqual(parseHelp(HELP), {
    commands: [],
    flags: [{ name: 'count', default: '2' }, { name: 'repo', default: 'o/r' }, { name: 'yes' }, { name: 'verbose' }],
  });
  const root = 'Usage:\n  gh nibfin [command]\n\nAvailable Commands:\n  completion  Generate\n  help        Help\n  runner      Runners\n  status      Status\n\nFlags:\n  -h, --help   help\n';
  deepEqual(parseHelp(root), { commands: ['runner', 'status'], flags: [] });
  const tree = new Map([['', root], ['runner', 'Available Commands:\n  add  Add\n'], ['runner add', HELP], ['status', 'Flags:\n      --json   json\n']]);
  deepEqual(leafCommands(tree), ['runner add', 'status']);
});

test('the remaining read-back line: present, absent, malformed', () => {
  deepEqual(parseRemaining('plan\nremaining: 1\n'), { count: 1 });
  deepEqual(parseRemaining('  remaining: 0'), { count: 0 });
  deepEqual(parseRemaining('removed claude-1 [confirmed]\n'), {});
  match(parseRemaining('remaining: one\n').error ?? '', /malformed line "remaining: one"/);
  match(parseRemaining('remaining: 1\nremaining: 2\n').error ?? '', /2 remaining: lines/);
});

test('a Nibfin run title must start with Nibfin and contain the Issue number as a whole number', () => {
  equal(isNibfinRunFor('Nibfin · o/r#12 · shape', 12), true);
  equal(isNibfinRunFor('Nibfin · o/r#123 · shape', 12), false);
  equal(isNibfinRunFor('Nibfin · o/r#112', 12), false);
  equal(isNibfinRunFor('CI · #12', 12), false);
});

test('Check collects every problem with its rule and hides secrets', async () => {
  const c = new Check();
  equal(c.that(true, 'R1.1', 'never'), true);
  equal(c.that(false, 'R5.1', 'first'), false);
  await c.part('R5.2', async () => {
    throw new Error('at http://127.0.0.1:1/#proof=abc123 with ghp_' + 'a'.repeat(30));
  });
  deepEqual(c.outcome('ok'), { status: 'failed', reason: 'R5.1: first; R5.2: at http://127.0.0.1:1/#proof=<hidden> with <token>' });
  deepEqual(new Check().outcome('all good'), { status: 'passed', reason: 'all good' });
  equal(redact('github_pat_' + 'b'.repeat(30)), '<token>');
  equal(tail({ stdout: 'x'.repeat(1000), stderr: '' }, 10), '…' + 'x'.repeat(10));
  match(precondition('a moved').reason, /^precondition not reached: a moved$/);
});

test('waitFor returns once the condition holds and fails at the deadline with the last value', async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  let n = 0;
  equal(await waitFor(async () => ++n, (v) => v === 3, { what: 'three', deadlineMs: 60_000, intervalMs: 1000, ...clock }), 3);
  equal(t, 2000);
  t = 0;
  await rejects(
    waitFor(async () => 'busy', () => false, { what: 'idle', deadlineMs: 5000, intervalMs: 2000, ...clock }),
    /timed out after 5 s waiting for idle; last seen: busy/,
  );
  t = 0;
  await rejects(
    waitFor(async () => {
      throw new Error('404');
    }, () => true, { what: 'x', deadlineMs: 1000, ...clock }),
    /last seen: error: 404/,
  );
});

function ghcr(digest: string | null, seen: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? 'GET'} ${url} ${new Headers(init?.headers).get('authorization') ?? ''}`);
    if (url.startsWith('https://ghcr.io/token')) return new Response(JSON.stringify({ token: 'anon' }));
    return new Response(null, { status: digest ? 200 : 404, headers: digest ? { 'docker-content-digest': digest } : {} });
  };
}

test('the GHCR :main digest is read anonymously; a moved :main is a precondition failure naming both digests', async () => {
  const seen: string[] = [];
  equal(await mainDigest(ghcr(D1, seen)), D1);
  deepEqual(seen, ['GET https://ghcr.io/token?scope=repository:taco3064/nibfin:pull ', 'HEAD https://ghcr.io/v2/taco3064/nibfin/manifests/main Bearer anon']);
  equal(await requireCurrentImage(D1, ghcr(D1)), undefined);
  deepEqual(await requireCurrentImage(D1, ghcr(D2)), {
    status: 'failed',
    reason: `precondition not reached: GHCR :main is ${D2}, init resolved ${D1}; a newer main image appeared after init`,
  });
  await rejects(mainDigest(ghcr(null)), /returned 404/);
});

test('the schema validator is strict: an unknown keyword fails to compile, a mismatch names the path', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    oneOf: [{ $ref: '#/$defs/V' }],
    $defs: { V: { type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'], additionalProperties: false } },
  };
  const v = schemaValidator(schema);
  deepEqual(v({ a: null }), []);
  equal(v({ a: 1 }).length > 0, true);
  match(v({}).join(' '), /must have required property 'a'/);
  throws(() => schemaValidator({ type: 'object', fancyKeyword: true }), /unknown keyword/);
});

test('host state parsing: unit files and .wslconfig', () => {
  deepEqual(parseUnitFiles('a.service enabled enabled\nb.timer static -\n\n2 unit files listed.\n'), [
    { name: 'a.service', state: 'enabled' },
    { name: 'b.timer', state: 'static' },
  ]);
  deepEqual(parseIni('[WSL2]\r\nmemory = 8GB\r\n# c\r\n[experimental]\nx=1\n'), { wsl2: { memory: '8GB' }, experimental: { x: '1' } });
  deepEqual(parseIni(null), {});
});

test('host state: the user manager runtime directory defaults to /run/user/<uid>', () => {
  equal(userRuntimeDir({ XDG_RUNTIME_DIR: '/x' }, 1000), '/x');
  equal(userRuntimeDir({}, 1001), '/run/user/1001');
});

test('host state before runner add: without a user manager the units come from the unit files, and no linger reads no', async () => {
  const seen: { argv: string[]; env?: Record<string, string> }[] = [];
  const run: HostRun = async (argv, env) => {
    seen.push({ argv, env });
    if (argv[0] === 'systemctl' && argv[1] === '--global') return { code: 0, stdout: 'gpg-agent.socket enabled enabled\nmine.service disabled enabled\nx.timer static -\n', stderr: '' };
    if (argv[0] === 'systemctl') return { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' };
    return { code: 1, stdout: '', stderr: 'Failed to get user: User runner is not logged in or lingering.' };
  };
  const state = await readLinuxHostState(run, { env: { PATH: '/usr/bin:/bin::/usr/bin' }, uid: 1001, user: 'runner', exists: () => false, systemFiles: () => ['a.service'], userEnabled: () => ['mine.service', 'own.timer'], now: () => 1234 });
  deepEqual(state, {
    platform: 'linux',
    units: [
      { name: 'gpg-agent.socket', state: 'enabled' },
      { name: 'mine.service', state: 'enabled' },
      { name: 'x.timer', state: 'static' },
      { name: 'own.timer', state: 'enabled' },
    ],
    linger: 'no',
    systemFiles: ['a.service'],
    readAt: 1234,
    pathDirs: ['/usr/bin', '/bin'],
  });
  deepEqual(
    seen.map((s) => [s.argv.slice(0, 3).join(' '), s.env]),
    [
      ['systemctl --user list-unit-files', { XDG_RUNTIME_DIR: '/run/user/1001' }],
      ['systemctl --global list-unit-files', undefined],
      ['loginctl show-user runner', { XDG_RUNTIME_DIR: '/run/user/1001' }],
    ],
  );

  const noGlobal: HostRun = async (argv) => (argv[0] === 'systemctl' ? { code: 1, stdout: '', stderr: argv[1] === '--global' ? 'unreadable' : 'no bus' } : { code: 0, stdout: 'no\n', stderr: '' });
  await rejects(readLinuxHostState(noGlobal, { env: {}, uid: 1001, user: 'runner', exists: () => false, systemFiles: () => [], userEnabled: () => [] }), /systemctl --global list-unit-files exited 1: unreadable/);
});

test('host state: the user\'s own enabled units are the entries of its .wants and .requires directories', () => {
  const work = join(import.meta.dirname, '..', '..', '.e2e-work');
  mkdirSync(work, { recursive: true });
  const home = mkdtempSync(join(work, 'test-units-'));
  try {
    deepEqual(userEnabledUnits({}, home), []);
    const dir = join(home, '.config', 'systemd', 'user');
    for (const d of ['default.target.wants', 'sockets.target.requires', 'other.d']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'default.target.wants', 'b.service'), '');
    writeFileSync(join(dir, 'sockets.target.requires', 'a.socket'), '');
    writeFileSync(join(dir, 'other.d', 'override.conf'), '');
    writeFileSync(join(dir, 'b.service'), '');
    deepEqual(userEnabledUnits({}, home), ['a.socket', 'b.service']);
    deepEqual(userEnabledUnits({ XDG_CONFIG_HOME: join(home, 'none') }, home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host state: a running user manager and a lingering user are read, and their failures still throw', async () => {
  const ok: HostRun = async (argv) =>
    argv[0] === 'systemctl' ? { code: 0, stdout: 'a.service enabled enabled\n', stderr: '' } : { code: 0, stdout: 'yes\n', stderr: '' };
  const opts = { env: { XDG_RUNTIME_DIR: '/r' }, uid: 1001, user: 'runner', systemFiles: () => [], now: () => 5 };
  deepEqual(await readLinuxHostState(ok, { ...opts, exists: () => true }), { platform: 'linux', units: [{ name: 'a.service', state: 'enabled' }], linger: 'yes', systemFiles: [], readAt: 5, pathDirs: [] });

  const unitsFail: HostRun = async (argv) => (argv[0] === 'systemctl' ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: 'no\n', stderr: '' });
  await rejects(readLinuxHostState(unitsFail, { ...opts, exists: (p) => p === '/r/bus' }), /systemctl --user list-unit-files exited 1: boom/);

  const lingerFail: HostRun = async (argv) => (argv[0] === 'systemctl' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'bad' });
  await rejects(readLinuxHostState(lingerFail, { ...opts, exists: (p) => p === '/var/lib/systemd/linger/runner' }), /loginctl show-user runner exited 1: bad/);
});

test('waitFor ends with the abort reason once its signal aborts', async () => {
  const c = new AbortController();
  let reads = 0;
  await rejects(
    waitFor(async () => (++reads === 2 && c.abort(new Error('harness budget of 190 min ran out')), 'busy'), () => false, { what: 'idle', deadlineMs: 60_000, intervalMs: 10, signal: c.signal }),
    /harness budget of 190 min ran out/,
  );
  equal(reads, 2);
});

// ---- runner-add-login (Proposal R5.30) -------------------------------------------

const CGROUP = 'WARNING: cgroup v2 delegation is missing; see https://rootlesscontaine.rs/getting-started/common/cgroup2/ for how to enable it.';

test('loginGuide: the open and enter code step lines, across CRLF, interleaved stdout and ANSI colour', () => {
  const out = `Preview:\r\n  linger: ok\r\n\x1b[1mopen https://auth.openai.com/codex/device\x1b[0m\r\nwaiting for login…\r\n\x1b[33menter code ABCD-12345\x1b[0m\r\n`;
  const g = loginGuide(out);
  equal(g.url, 'https://auth.openai.com/codex/device');
  equal(g.code, 'ABCD-12345');
  deepEqual(g.secrets, ['https://auth.openai.com/codex/device', 'ABCD-12345']);
  equal(loginGuide('a\ropen https://x.example/a\rb').url, 'https://x.example/a');
});

test('loginGuide: an advisory URL is no guide, but stays a secret', () => {
  const g = loginGuide(`${CGROUP}\n`);
  equal(g.url, undefined);
  equal(GUIDE_LINE.test(CGROUP), false);
  deepEqual(g.secrets, ['https://rootlesscontaine.rs/getting-started/common/cgroup2/']);
});

test('loginGuide: open mid-sentence does not count; GitHub URLs are not secrets', () => {
  const g = loginGuide('please open https://example.com/login in a browser\nsee https://github.com/o/r and https://api.github.com/x and https://objects.githubusercontent.com/y\n');
  equal(g.url, undefined);
  equal(GUIDE_LINE.test('please open https://example.com/login in a browser'), false);
  deepEqual(g.secrets, ['https://example.com/login']);
});

test('loginGuide: an enter code line or a code-shaped token alone is a secret, not a guide', () => {
  const a = loginGuide('enter code WXYZ-9876\n');
  equal(a.url, undefined);
  equal(a.code, 'WXYZ-9876');
  deepEqual(a.secrets, ['WXYZ-9876']);
  const b = loginGuide('Your one-time code: QRST-5678 (expires in 15 minutes)\n');
  equal(b.url, undefined);
  equal(b.code, undefined);
  deepEqual(b.secrets, ['QRST-5678']);
});

test('guideTail hides every login value before cutting, and strips ANSI', () => {
  const out = `x`.repeat(50) + `\n\x1b[1mopen https://auth.example/device?user_code=ABCD-EFGH\x1b[0m\nenter code ABCD-EFGH\n`;
  const t = guideTail(out, 40);
  equal(t.includes('auth.example'), false);
  equal(t.includes('ABCD'), false);
  equal(t.includes('\x1b'), false);
  match(t, /^…/);
  match(guideTail(out), /open <redacted>/);
  equal(guideTail(`${CGROUP}`).includes('rootlesscontaine'), false);
});

test('SUCCESS_LINE matches a finished login, not "not logged in"', () => {
  equal(SUCCESS_LINE.test('Successfully logged in'), true);
  equal(SUCCESS_LINE.test('login complete'), true);
  equal(SUCCESS_LINE.test('codex: not logged in'), false);
});

/** A child whose output and exit the test drives. */
function drivenChild() {
  let out = '';
  let exited = false;
  const waiters = new Set<() => void>();
  return {
    write: (s: string) => void (out += s),
    exit() {
      exited = true;
      for (const w of waiters) w();
    },
    output: () => out,
    waitFor: (_p: RegExp, ms: number) =>
      new Promise<RegExpExecArray>((_resolve, reject) => {
        if (exited) return reject(new Error('exited'));
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.add(() => (clearTimeout(t), reject(new Error('exited'))));
      }),
  };
}

test('waitForOutput: found when the step line streams in, exited when the child ends first, timeout otherwise', async () => {
  const find = (o: string) => loginGuide(o).url;
  const a = drivenChild();
  setTimeout(() => a.write(`${CGROUP}\n`), 5);
  setTimeout(() => a.write('open https://auth.example/d\n'), 20);
  deepEqual(await waitForOutput(a, find, 2000, { pollMs: 5 }), { end: 'found', value: 'https://auth.example/d' });
  a.exit();

  const b = drivenChild();
  b.write(`${CGROUP}\n`);
  setTimeout(() => b.exit(), 10);
  deepEqual(await waitForOutput(b, find, 2000, { pollMs: 5 }), { end: 'exited' });

  const c = drivenChild();
  setTimeout(() => (c.write('open https://auth.example/late\n'), c.exit()), 10);
  deepEqual(await waitForOutput(c, find, 2000, { pollMs: 50 }), { end: 'found', value: 'https://auth.example/late' });

  const d = drivenChild();
  deepEqual(await waitForOutput(d, find, 30, { pollMs: 5 }), { end: 'timeout' });
  d.exit();

  const e = drivenChild();
  const ac = new AbortController();
  ac.abort();
  deepEqual(await waitForOutput(e, find, 2000, { pollMs: 5, signal: ac.signal }), { end: 'aborted' });
  e.exit();
});

test('statusRunners reads one provider from .host.runners.runners; an unreadable list is undefined', () => {
  const s = {
    host: {
      host: { running: true },
      runners: { runners: [{ provider: 'claude', status: 'online' }, { provider: 'codex', status: 'offline' }] },
      providers: [{ provider: 'codex', loggedIn: false }],
    },
    repos: null,
  };
  deepEqual(statusRunners(s, 'codex'), [{ provider: 'codex', status: 'offline' }]);
  deepEqual(statusRunners(s, 'claude')?.length, 1);
  deepEqual(statusRunners({ host: { runners: { runners: null } } }, 'codex'), []);
  equal(statusRunners({ runners: { runners: [{ provider: 'codex' }] } }, 'codex'), undefined);
  equal(statusRunners({ host: {} }, 'codex'), undefined);
  equal(statusRunners(null, 'codex'), undefined);
});

test('providerLogin: true, false and undefined; claudeLoggedIn keeps its results', () => {
  const s = { providers: [{ provider: 'claude', loggedIn: true }, { provider: 'codex', loggedIn: false, error: 'x' }] };
  equal(providerLogin(s, 'claude'), true);
  equal(providerLogin(s, 'codex'), false);
  equal(providerLogin({ providers: [{ provider: 'claude', loggedIn: true }] }, 'codex'), undefined);
  equal(providerLogin({ logins: { codex: { loggedIn: 'not logged in' } } }, 'codex'), false);
  equal(providerLogin({ logins: { codex: { signedIn: 'yes' } } }, 'codex'), true);
  equal(claudeLoggedIn(s), true);
  equal(claudeLoggedIn({ providers: [{ provider: 'claude', loggedIn: false }] }), false);
  equal(claudeLoggedIn({ claude: { login: 'logged-in' } }), true);
  equal(claudeLoggedIn({ providers: [{ provider: 'codex', loggedIn: true }] }), false);
  equal(claudeLoggedIn({}), false);
});
