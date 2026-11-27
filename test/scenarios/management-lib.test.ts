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
import { guideTail, GUIDE_LINE, loginGuide, loginRefusal, PASTE_PROMPT, statusRunners, SUCCESS_LINE, volumeContainers, volumeExists, waitForOutput } from '../../scenarios/management/login-guide.ts';
import { describeLogin, isCliLogin, parseIds, pickLogin, projectLogin } from '../../scenarios/management/login-container.ts';
import type { LoginContainer } from '../../scenarios/management/login-container.ts';
import { LABEL_REPO } from '../../scenarios/lib/containers.ts';
import { claudeLoggedIn, providerLogin } from '../../scenarios/dashboard/support.ts';
import { readWorkflow, titleStartsWith, triggers, unpinnedImages } from '../../scenarios/lib/workflows.ts';

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

test('workflow reads: block-scalar name and run-name, folded or literal, end at the next top-level key', () => {
  const folded = readWorkflow(`name: >-
  Nibfin ·
  Shared runner
run-name: >-
  \${{ inputs.issue != ''
  && format('Nibfin · {0}#{1}', inputs.repo, inputs.issue)
  || 'Nibfin · route' }}

on: workflow_dispatch
`);
  equal(folded.name, 'Nibfin · Shared runner');
  equal(folded.runName, "${{ inputs.issue != '' && format('Nibfin · {0}#{1}', inputs.repo, inputs.issue) || 'Nibfin · route' }}");
  equal(readWorkflow('run-name: |\n  Nibfin\n  · run\njobs: {}\n').runName, 'Nibfin\n· run\n');
  equal(readWorkflow('run-name: |-\n    Nibfin\n    · run\n\n# c\non: push\n').runName, 'Nibfin\n· run');
  equal(readWorkflow('run-name: >\n  a\n  b\n\n  c\n').runName, 'a b\nc\n');
  equal(readWorkflow('run-name: >-   # folded\n  Nibfin x\n').runName, 'Nibfin x');
  equal(readWorkflow("run-name: '>- not a block'\n").runName, '>- not a block');
});

test('workflow triggers: scalar, flow list, flow mapping, block mapping and block list', () => {
  deepEqual(triggers('on: push\n'), ['push']);
  deepEqual(triggers('on: [push, "issues"]\n'), ['push', 'issues']);
  deepEqual(triggers('on: { push: {}, workflow_call: {} }\n'), ['push', 'workflow_call']);
  deepEqual(triggers('name: x\non:\n  workflow_call:\n    inputs:\n      a:\n        type: string\n  # note\n  issues:\n    types: [opened]\njobs: {}\n'), ['workflow_call', 'issues']);
  deepEqual(triggers('"on":\n  - push\n  - workflow_call\njobs: {}\n'), ['push', 'workflow_call']);
  deepEqual(triggers('on: [workflow_call, # reusable\n  issues]\njobs: {}\n'), ['workflow_call', 'issues']);
  deepEqual(triggers('jobs: {}\n'), []);
});

test('run titles: every title an expression can render must start with the prefix', () => {
  const shared = "${{ inputs.issue != '' && format('Nibfin · {0}#{1} · {2}', inputs.repo, inputs.issue, inputs.stage) || format('Nibfin · {0}@{1} · route', inputs.repo, inputs.ref) }}";
  const issue = "${{ github.event.issue && format('Nibfin · {0}#{1} · wake', github.repository, github.event.issue.number) || format('Nibfin · {0}@{1} · wake', github.repository, github.event.workflow_run && (github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.head_branch || github.event.workflow_run.head_sha) || github.event.pull_request.head.ref || github.sha) }}";
  equal(titleStartsWith(shared, 'Nibfin'), true);
  equal(titleStartsWith(issue, 'Nibfin'), true);
  equal(titleStartsWith('Nibfin · ${{ inputs.issue }}', 'Nibfin'), true);
  equal(titleStartsWith("${{ x && 'Nibfin a' || ('Nibfin b') }}", 'Nibfin'), true);
  equal(titleStartsWith("${{ x || 'Other' }}", 'Nibfin'), false);
  equal(titleStartsWith("${{ x && format('Nibfin {0}', y) }}", 'Nibfin'), false);
  equal(titleStartsWith("${{ x || 'Nibfin' }}", 'Nibfin'), false);
  equal(titleStartsWith("${{ format('Nibfin {0}', y) == 'z' }}", 'Nibfin'), false);
  equal(titleStartsWith("${{ format('{0} Nibfin', y) }}", 'Nibfin'), false);
  equal(titleStartsWith("${{ 'Nibfin' }} and ${{ x }}", 'Nibfin'), false);
  equal(titleStartsWith('Other', 'Nibfin'), false);
  equal(titleStartsWith('', 'Nibfin'), false);
});

test('unpinned images: a bare name passes only next to the digest, assigned and compared, never used otherwise', () => {
  const job = (run: string, env = `  IMAGE: ghcr.io/taco3064/nibfin\n  IMAGE_REF: ghcr.io/taco3064/nibfin@${D1}\n`) =>
    `on:\n  workflow_call:\nenv:\n${env}jobs:\n  s:\n    runs-on: [self-hosted, nibfin-1]\n    steps:\n      - run: |\n          ${run}\n`;
  const bare = [{ ref: 'ghcr.io/taco3064/nibfin', why: 'run without a digest' }];
  // Passes: assigned, then only compared, as when telling older local images apart.
  deepEqual(unpinnedImages(job('podman run --rm \\\n            "$IMAGE_REF" nibfin run\n          if [ "$r" != "$IMAGE" ]; then continue; fi\n          [[ ${IMAGE} == "$x" ]]'), D1), []);
  deepEqual(unpinnedImages(job('IMAGE=ghcr.io/taco3064/nibfin\n          [ "$r" = "$IMAGE" ]'), D1), []);
  // The digest must be in the file or a caller.
  deepEqual(unpinnedImages(job('echo', '  IMAGE: ghcr.io/taco3064/nibfin\n'), D1), [{ ref: 'ghcr.io/taco3064/nibfin', why: 'with no expected digest in the file or its caller' }]);
  deepEqual(unpinnedImages(job('echo', '  IMAGE: ghcr.io/taco3064/nibfin\n'), D1, [`with:\n  digest: ${D1}\n`]), []);
  // Other references fail on their own.
  deepEqual(unpinnedImages(job('podman run ghcr.io/taco3064/nibfin:latest'), D1), [{ ref: 'ghcr.io/taco3064/nibfin:latest' }]);
  deepEqual(unpinnedImages(job(`podman run ghcr.io/taco3064/nibfin@${D2}`), D1), [{ ref: `ghcr.io/taco3064/nibfin@${D2}` }]);
  // Run, pulled or created, literally or through the variable, however written.
  for (const run of [
    'podman run --rm \\\n            "$IMAGE" nibfin run',
    'podman pull ${IMAGE}',
    'podman create ghcr.io/taco3064/nibfin',
    'podman --log-level debug run "$IMAGE"',
    'docker run ghcr.io/taco3064/nibfin',
    'echo "$IMAGE" | xargs podman run --rm',
    'podman run "${IMAGE:-x}"',
    'podman run "${IMAGE%%@*}"',
    'P=podman; $P run "$IMAGE"',
    'IMG="$IMAGE"\n          podman run "$IMG"',
    'IMG="$IMAGE:latest"\n          podman run "$IMG"',
    `IMG="\${IMAGE}@${D2}"\n          podman run "$IMG"`,
    'echo "img=$IMAGE" >> "$GITHUB_OUTPUT"',
    '[ "$(podman run "$IMAGE")" = x ]',
    '[ "$r" != "$IMAGE" ] || podman run "$IMAGE"',
  ]) deepEqual(unpinnedImages(job(run), D1), bare, run);
  // Expressions, matrices, inputs, values below their key, image keys.
  const swap = (from: string, to: string) => job('x').replace(from, to);
  deepEqual(unpinnedImages(swap('          x\n', '          podman run "${{ env[\'IMAGE\'] }}"\n'), D1), bare);
  deepEqual(unpinnedImages(swap('    steps:\n', '    strategy:\n      matrix:\n        img:\n          - ghcr.io/taco3064/nibfin\n    steps:\n'), D1), bare);
  deepEqual(unpinnedImages(swap('  workflow_call:\n', '  workflow_call:\n    inputs:\n      image:\n        type: string\n        default: ghcr.io/taco3064/nibfin\n'), D1), bare);
  deepEqual(unpinnedImages(swap('  IMAGE: ghcr.io/taco3064/nibfin\n', '  IMAGE:\n    ghcr.io/taco3064/nibfin\n'), D1), bare);
  deepEqual(unpinnedImages(swap('  IMAGE: ghcr.io/taco3064/nibfin\n', '  IMAGE: >-\n    ghcr.io/taco3064/nibfin\n'), D1), bare);
  deepEqual(unpinnedImages(swap('    steps:\n', '    container: ghcr.io/taco3064/nibfin\n    steps:\n'), D1), bare);
  deepEqual(unpinnedImages(swap('    steps:\n', '    container:\n      image: ${{ env.IMAGE }}\n    steps:\n'), D1), bare);
  deepEqual(unpinnedImages(swap('      - run: |\n', '      - uses: docker://ghcr.io/taco3064/nibfin\n      - run: |\n'), D1), bare);
  // A caller passing the bare name in.
  const called = 'on:\n  workflow_call:\n    inputs:\n      img:\n        type: string\njobs:\n  s:\n    steps:\n      - run: podman run "${{ inputs.img }}"\n';
  const caller = `env:\n  D: ${D1}\njobs:\n  j:\n    uses: ./.github/workflows/nibfin-job.yml\n    with:\n      img: ghcr.io/taco3064/nibfin\n`;
  deepEqual(unpinnedImages(called, D1, [caller]), bare);
  deepEqual(unpinnedImages(called, D1, []), []);
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

// ---- login-command (Proposal R5.34) ----------------------------------------------

test('loginGuide: a Claude re-login guide, with the paste prompt left without a newline', () => {
  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=abc-123&state=xyz789';
  const out = `Preview:\n  login claude: logs in again when already logged in\n\x1b[1mopen ${url}\x1b[0m\npaste the code shown in your browser: `;
  const g = loginGuide(out);
  equal(g.url, url);
  equal(g.secrets.includes(url), true);
  equal(PASTE_PROMPT.test(out), true);
  equal(guideTail(out).includes('claude.ai/oauth'), false);
});

test('loginRefusal: the no_runners refusal for the named provider, with a non-zero exit and no guide', () => {
  const refusal = 'no_runners: no codex runners on gate-host; add runners first: gh nibfin runner add codex\n';
  deepEqual(loginRefusal(1, refusal, 'codex'), { refused: true, guide: false });
  deepEqual(loginRefusal(0, refusal, 'codex'), { refused: false, guide: false });
  deepEqual(loginRefusal(1, 'podman_failed: podman run exited 125: image not known\n', 'codex'), { refused: false, guide: false });
  deepEqual(loginRefusal(1, `${refusal}open https://auth.openai.com/codex/device\n`, 'codex'), { refused: false, guide: true });
  deepEqual(loginRefusal(1, `${refusal}paste the code shown in your browser: `, 'codex'), { refused: false, guide: true });
  deepEqual(loginRefusal(1, `\x1b[31mno_runners: no codex runners on h;\x1b[0m\r\n`, 'codex'), { refused: true, guide: false });
  deepEqual(loginRefusal(1, 'see: gh nibfin runner add codex\r\n', 'codex'), { refused: true, guide: false });
  // The provider argument counts: a claude refusal is no codex refusal.
  deepEqual(loginRefusal(1, 'no_runners: no claude runners on h; add runners first: gh nibfin runner add claude\n', 'codex'), { refused: false, guide: false });
  // "codexx" is another word.
  deepEqual(loginRefusal(1, 'no codexx runners\n', 'codex'), { refused: false, guide: false });
});

test('volumeExists and volumeContainers read podman through exec', async () => {
  const calls: string[][] = [];
  const ctx = (code: number, stdout = '') => ({
    exec: async (argv: string[]) => (calls.push(argv), { code, stdout, stderr: code === 125 ? 'boom' : '' }),
  }) as unknown as Parameters<typeof volumeExists>[0];
  equal(await volumeExists(ctx(0), 'v1'), true);
  equal(await volumeExists(ctx(1), 'v1'), false);
  await rejects(volumeExists(ctx(125), 'v1'), /podman volume exists v1 exited 125: boom/);
  deepEqual(calls[0], ['podman', 'volume', 'exists', 'v1']);
  deepEqual(await volumeContainers(ctx(0, 'aaa\n bbb \n\n'), 'v2'), ['aaa', 'bbb']);
  deepEqual(calls.at(-1), ['podman', 'ps', '-a', '--filter', 'volume=v2', '--format', '{{.ID}}']);
  await rejects(volumeContainers(ctx(125), 'v2'), /podman ps -a --filter volume=v2 exited 125/);
});

// ---- runner-add-login: the login container (Proposal R6.11) -------------------------

const JOB_IMAGE = 'a'.repeat(64);
const OTHER_IMAGE = 'b'.repeat(64);

/** A `podman container inspect` document shaped like gh-nibfin's Codex login container. */
function inspectDoc(over: { id?: string; image?: string; entrypoint?: unknown; cmd?: unknown; tty?: boolean; stdin?: boolean; running?: boolean; labels?: Record<string, string> } = {}) {
  return [
    {
      Id: over.id ?? '1234567890ab' + 'c'.repeat(52),
      Image: over.image ?? JOB_IMAGE,
      ImageName: 'ghcr.io/taco3064/nibfin:main',
      ImageDigest: D1,
      Config: {
        Entrypoint: 'entrypoint' in over ? over.entrypoint : ['/usr/bin/tini', '--'],
        Cmd: 'cmd' in over ? over.cmd : ['codex', 'login', '--device-auth'],
        Tty: over.tty ?? false,
        OpenStdin: over.stdin ?? true,
        Env: ['PATH=/usr/bin', 'OPENAI_API_KEY=sk-secret-value', 'NIBFIN_GITHUB_TOKEN=ghp_secretsecretsecretsecret'],
        Labels: over.labels ?? { 'org.opencontainers.image.source': 'x' },
      },
      State: { Running: over.running ?? true },
      HostConfig: { Memory: 0 },
    },
  ];
}

const login = (over: Parameters<typeof inspectDoc>[0] = {}): LoginContainer => projectLogin(inspectDoc(over)) as LoginContainer;

test('projectLogin keeps only the allowlisted fields; Entrypoint as an array or a string; Env never appears', () => {
  const c = login();
  deepEqual(c, {
    id: '1234567890ab' + 'c'.repeat(52),
    imageName: 'ghcr.io/taco3064/nibfin:main',
    imageId: JOB_IMAGE,
    imageDigest: D1,
    argv: ['/usr/bin/tini', '--', 'codex', 'login', '--device-auth'],
    tty: false,
    openStdin: true,
    running: true,
    job: false,
  });
  equal(JSON.stringify(c).includes('secret'), false);
  deepEqual(login({ entrypoint: '/entry.sh', cmd: ['codex', 'login'] }).argv, ['/entry.sh', 'codex', 'login']);
  deepEqual(login({ entrypoint: null, cmd: null }).argv, []);
  equal(login({ labels: { [LABEL_REPO]: 'o/r' } }).job, true);
  deepEqual(projectLogin({ Config: null }), { id: '', imageName: '', imageId: '', imageDigest: '', argv: [], tty: false, openStdin: false, running: false, job: false });
  equal(projectLogin([]), undefined);
  equal(projectLogin(null), undefined);
});

test('isCliLogin: codex login and codex login --device-auth only', () => {
  equal(isCliLogin(['codex', 'login']), true);
  equal(isCliLogin(['codex', 'login', '--device-auth']), true);
  equal(isCliLogin(['/usr/bin/tini', '--', 'codex', 'login', '--device-auth']), true);
  equal(isCliLogin(['/usr/local/bin/codex', 'login']), true);
  equal(isCliLogin(['codex', 'login', 'status']), false);
  equal(isCliLogin(['codex', 'login', '--with-api-key']), false);
  equal(isCliLogin(['codex', 'login', '--device-auth', 'extra']), false);
  equal(isCliLogin(['codex', 'exec', 'login']), false);
  equal(isCliLogin(['claude', 'auth', 'login']), false);
  equal(isCliLogin(['nibfin-login', 'codex']), false);
  equal(isCliLogin(['mycodex', 'login']), false);
  equal(isCliLogin([]), false);
});

test('pickLogin matches only a non-Job, running, interactive codex login from the Jobs image id', () => {
  const ok = login({ id: 'f'.repeat(64) });
  deepEqual(pickLogin([ok], JOB_IMAGE), { match: ok, problems: [] });
  equal(pickLogin([login({ tty: true, stdin: false })], `sha256:${JOB_IMAGE}`).match?.tty, true);
  deepEqual(pickLogin([], JOB_IMAGE), { problems: [] });

  const other = login({ id: '1'.repeat(64), image: OTHER_IMAGE });
  const flat = login({ id: '2'.repeat(64), stdin: false, tty: false, cmd: ['codex', 'login'] });
  const status = login({ id: '3'.repeat(64), stdin: false, cmd: ['codex', 'login', 'status'] });
  const job = login({ id: '4'.repeat(64), labels: { [LABEL_REPO]: 'o/r' } });
  const stopped = login({ id: '5'.repeat(64), running: false });
  const r = pickLogin([other, flat, status, job, stopped], JOB_IMAGE);
  equal(r.match, undefined);
  equal(r.problems.length, 5);
  match(r.problems[0] ?? '', /^container 111111111111 image ghcr\.io\/taco3064\/nibfin:main \(sha256:1+, id bbbbbbbbbbbb\) command "\/usr\/bin\/tini -- codex login --device-auth" Tty=false OpenStdin=true: image id differs from the Jobs' image id aaaaaaaaaaaa$/);
  match(r.problems[1] ?? '', /^container 222222222222 .* command "\/usr\/bin\/tini -- codex login" Tty=false OpenStdin=false: not interactive$/);
  match(r.problems[2] ?? '', /^container 333333333333 .*"\/usr\/bin\/tini -- codex login status" Tty=false OpenStdin=false: not interactive, not the CLI's own login/);
  match(r.problems[3] ?? '', /^container 444444444444 .*: carries the Job label io\.github\.taco3064\.nibfin\.repo$/);
  match(r.problems[4] ?? '', /: not running$/);
  // A later match still wins; earlier misses stay as evidence.
  const later = pickLogin([status, ok], JOB_IMAGE);
  equal(later.match, ok);
  equal(later.problems.length, 1);
  match(describeLogin(projectLogin({}) as LoginContainer), /^container \(none\) image \(none\) \(no digest, id \(none\)\) command "" Tty=false OpenStdin=false$/);
});

test('parseIds reads podman ps --no-trunc --format {{.ID}} output', () => {
  deepEqual(parseIds(`${'a'.repeat(64)}\n\n  ${'b'.repeat(64)}  \n`), ['a'.repeat(64), 'b'.repeat(64)]);
  deepEqual(parseIds(''), []);
  deepEqual(parseIds('\n'), []);
});
