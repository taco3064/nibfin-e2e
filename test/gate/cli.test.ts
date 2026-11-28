import { deepEqual, equal, match } from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SourceFile } from '../../src/gate/changes.ts';
import { main, readResultFiles } from '../../src/gate/cli.ts';
import type { Env } from '../../src/host/exec.ts';
import { map, scenarios } from '../fixtures.ts';
import { FakeGate } from './fake.ts';

const base: Env = {
  NIBFIN_GITHUB_TOKEN: 'owner-secret',
  GITHUB_RUN_ID: '7',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'taco3064/nibfin-e2e',
  GITHUB_EVENT_PATH: 'event.json',
};

async function gate(
  argv: string[],
  opts: { env?: Env; files?: Record<string, string>; gh?: FakeGate; sources?: SourceFile[] } = {},
) {
  const gh = opts.gh ?? new FakeGate();
  gh.runs.set('7', { created_at: '2026-11-27T09:00:00Z', run_attempt: 1 });
  let stdout = '';
  let stderr = '';
  const tokens: string[] = [];
  const code = await main(argv, {
    env: opts.env ?? base,
    github: (token) => (tokens.push(token()), gh),
    loadMap: () => ({ entries: map, errors: [] }),
    scenarios,
    steps: [],
    readFile: (path) => {
      const text = opts.files?.[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    readResults: () => [],
    sources: () => opts.sources ?? [],
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
  });
  equal(stdout.includes('owner-secret') || stderr.includes('owner-secret'), false);
  return { code, json: JSON.parse(stdout), stderr, gh, tokens };
}

test('bad input exits 2 with one JSON document and makes no GitHub call', async () => {
  const event = JSON.stringify({
    action: 'proposal-updated',
    client_payload: { page_id: 'p', block_ids: [], timestamp: '2026-11-27T00:00:00Z' },
  });
  const cases: [string[], Env, Record<string, string>, RegExp][] = [
    [['bogus'], base, {}, /unknown subcommand/],
    [['select'], base, {}, /exactly one of/],
    [['select', '--all', '--rule', 'R3.1'], base, {}, /exactly one of/],
    [['select', '--delivered', 'taco3064/other#1'], base, {}, /must be one of/],
    [['select', '--delivered', 'taco3064/nibfin-core'], base, {}, /expected <owner\/repo>#<n>/],
    [['select', '--rule', 'R9.9'], base, {}, /not in the coverage map/],
    [['select', '--all', '--bogus'], base, {}, /Unknown option/],
    [['select', '--all'], { ...base, NIBFIN_GITHUB_TOKEN: '' }, {}, /missing environment variable NIBFIN_GITHUB_TOKEN/],
    [['report'], base, {}, /needs --results/],
    [
      ['report', '--leg', '--plan', 'plan.json', '--results', 'r'],
      { ...base, RUNNER_NAME: 'host-w' },
      { 'plan.json': '{}' },
      /--leg cannot take --plan/,
    ],
    [['report', '--leg', '--results', 'r'], base, {}, /--leg needs RUNNER_NAME/],
    [['report', '--leg', '--results', 'r'], { ...base, RUNNER_NAME: ' ' }, {}, /--leg needs RUNNER_NAME/],
    [
      ['report', '--results', 'r'],
      { ...base, GITHUB_REPOSITORY: 'someone/fork' },
      {},
      /GITHUB_REPOSITORY must be taco3064\/nibfin-e2e/,
    ],
    [['report', '--results', 'r'], { ...base, GITHUB_RUN_ID: undefined }, {}, /GITHUB_RUN_ID/],
    [['proposal-updated'], base, {}, /cannot read GITHUB_EVENT_PATH/],
    [['proposal-updated'], base, { 'event.json': '{"action":"other"}' }, /action must be proposal-updated/],
    [['proposal-updated'], { ...base, GITHUB_EVENT_PATH: undefined }, { 'event.json': event }, /GITHUB_EVENT_PATH/],
    [['proposal-updated'], { ...base, NIBFIN_GITHUB_TOKEN: undefined }, { 'event.json': event }, /NIBFIN_GITHUB_TOKEN/],
  ];
  for (const [argv, env, files, expected] of cases) {
    const r = await gate(argv, { env, files });
    equal(r.code, 2, argv.join(' '));
    match(r.json.error.messages.join('\n'), expected, argv.join(' '));
    deepEqual([r.gh.reads, r.gh.writes, r.tokens], [[], [], []], argv.join(' '));
  }
});

test('select prints the plan and uses the Owner token only through the GitHub client', async () => {
  const r = await gate(['select', '--section', '5']);
  equal(r.code, 0);
  deepEqual(r.json.selection, { all: false, rules: ['R5.13', 'R5.14'] });
  deepEqual(r.tokens, ['owner-secret']);
  deepEqual(r.gh.writes, []);
});

test('select --delivered for a nibfin-e2e Issue maps its changed scenario files through the checkout', async () => {
  const gh = new FakeGate();
  gh.addIssue('taco3064/nibfin-e2e', {
    title: 'fix',
    state: 'closed',
    labels: ['delivered'],
    comments: [
      {
        body: '<!-- nibfin:shape -->\nProposal rules: none',
        user: 'taco3064',
        updated_at: '2026-11-26T00:00:00Z',
        html_url: 's',
      },
    ],
  });
  gh.addPull('taco3064/nibfin-e2e', {
    number: 9,
    head: 'nibfin/issue-1',
    files: [{ filename: 'scenarios/x.ts', status: 'modified' }],
  });
  const r = await gate(['select', '--delivered', 'taco3064/nibfin-e2e#1'], {
    gh,
    sources: [{ path: 'scenarios/x.ts', text: "export const b = { id: 'b' };" }],
  });
  equal(r.code, 0);
  deepEqual(r.json.selection, { all: false, rules: ['R3.2', 'R5.13'] });
  deepEqual(r.json.source.pulls, ['https://github.com/taco3064/nibfin-e2e/pull/9']);
});

test('report and proposal-updated exit 1 on a failure and 0 when all is well', async () => {
  const plan = JSON.stringify({
    selection: { all: false, rules: [] },
    gaps: [],
    unselectedGaps: [],
    coverage: { passed: true, covered: 1, total: 1 },
    source: null,
  });
  const ok = await gate(['report', '--plan', 'plan.json', '--results', 'r'], { files: { 'plan.json': plan } });
  equal(ok.code, 0);
  match(ok.json.summary, /^## Gate report/);
  const noPlan = await gate(['report', '--results', 'r']);
  equal(noPlan.code, 1);
  const retest = JSON.stringify({
    selection: { all: false, rules: [] },
    gaps: [],
    unselectedGaps: [{ id: 'R3.9', missingPlatforms: ['linux'] }],
    coverage: { passed: false, covered: 0, total: 1 },
    source: null,
  });
  equal((await gate(['report', '--plan', 'plan.json', '--results', 'r'], { files: { 'plan.json': retest } })).code, 0);
  const all = JSON.stringify({
    selection: { all: true },
    gaps: [],
    unselectedGaps: [{ id: 'R3.9', missingPlatforms: ['linux'] }],
    coverage: { passed: false, covered: 0, total: 1 },
    source: null,
  });
  equal((await gate(['report', '--plan', 'plan.json', '--results', 'r'], { files: { 'plan.json': all } })).code, 1);
  const event = JSON.stringify({
    action: 'proposal-updated',
    client_payload: { page_id: 'p', block_ids: ['b'], timestamp: '2026-11-27T00:00:00Z' },
  });
  const filed = await gate(['proposal-updated'], { files: { 'event.json': event } });
  equal(filed.code, 0);
  equal(filed.json.filed[0].decision, 'created');
  const gh = new FakeGate();
  gh.dropOnCreate = { assignees: true };
  equal((await gate(['proposal-updated'], { files: { 'event.json': event }, gh })).code, 1);
});

test('report --leg files its own job when it left no result, and exits 0 when its job is not in the run', async () => {
  const gh = new FakeGate();
  gh.jobs.set('7', [
    {
      name: 'run (ubuntu-24.04)',
      status: 'in_progress',
      conclusion: null,
      runner_name: 'host-l',
      html_url: 'j',
      steps: [],
    },
  ]);
  const r = await gate(['report', '--leg', '--results', 'leg'], { env: { ...base, RUNNER_NAME: 'host-l' }, gh });
  equal(r.code, 1);
  deepEqual(
    r.json.filed.map((f: { title: string }) => f.title),
    ['Job failed: run (ubuntu-24.04)'],
  );
  match(r.json.summary, /^## Gate report for this leg/);
  const quiet = await gate(['report', '--leg', '--results', 'leg'], { env: { ...base, RUNNER_NAME: 'gone' } });
  equal(quiet.code, 0);
  deepEqual([quiet.json.filed, quiet.gh.writes], [[], []]);
});

test('a GitHub read error exits 1 and names it', async () => {
  const gh = new FakeGate();
  gh.crash = { at: 'GET /repos/taco3064/nibfin-core/issues/3' };
  const r = await gate(['select', '--delivered', 'taco3064/nibfin-core#3'], { gh });
  equal(r.code, 1);
  equal(r.json.error.kind, 'github');
});

test('readResultFiles finds every json file recursively and reports an unreadable directory', () => {
  const files = readResultFiles('sandbox-template');
  deepEqual(
    files.map((f) => [f.path, typeof f.text]),
    [[join('sandbox-template', 'package.json'), 'string']],
  );
  deepEqual(readResultFiles(join('test', 'gate')), []);
  match(readResultFiles(join('test', 'no-such-dir'))[0]?.error ?? '', /cannot read the results directory/);
});
