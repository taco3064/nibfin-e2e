import { deepEqual, equal, match, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { parseIni, parseUnitFiles } from '../../src/host/hoststate.ts';
import { Check, precondition, redact, tail } from '../../scenarios/lib/check.ts';
import { isNibfinRunFor, leafCommands, parseHelp, parseRemaining } from '../../scenarios/lib/gh.ts';
import { mainDigest, requireCurrentImage } from '../../scenarios/lib/image.ts';
import { schemaValidator } from '../../scenarios/lib/schema.ts';
import { waitFor } from '../../scenarios/lib/wait.ts';
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
