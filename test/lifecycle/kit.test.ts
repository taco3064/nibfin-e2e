import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { Kit, hostedRunProblems, lifecycle, redact, stageSeen } from '../../scenarios/lifecycle/kit.ts';
import { Observer } from '../../scenarios/lifecycle/observe.ts';
import { closingProblems } from '../../scenarios/lifecycle/phase1.ts';
import { isProtected, peerIssueBody, writeConflict } from '../../scenarios/lifecycle/phase2-fixtures.ts';
import { credentialOutcome, leaks, scan } from '../../scenarios/lifecycle/phase3.ts';
import { SCOPE_ISSUES, scopeGate } from '../../scenarios/lifecycle/requests.ts';
import { clock, context, routes } from './fake.ts';
import type { Handler } from './fake.ts';

const empty = {
  'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
  'GET /repos/o/exec/issues': [],
  'GET /repos/o/exec/pulls': [],
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /rate_limit': { resources: { core: { remaining: 4999 } } },
};

test('waiters share one snapshot, refreshed at most once per interval', async () => {
  const f = routes(empty);
  const c = clock();
  const obs = new Observer(f.github, ['o/exec', 'o/peer'], {
    since: c.now(),
    now: c.now,
    sleep: c.sleep,
    intervalMs: 60_000,
  });
  let polls = 0;
  const waiter = (after: number) => obs.until('x', () => (++polls >= after ? true : undefined), 600_000);
  await Promise.all([waiter(3), waiter(4), waiter(5)]);
  const reads = f.calls.filter((x) => x.startsWith('GET /repos/o/exec/actions/runs'));
  equal(reads.length <= 3, true, `${reads.length} snapshots for three waiters`);
  match(reads[0] ?? '', /created=%3E%3D2026-11-26T10%3A00%3A00Z/);
});

test('until fails at its deadline naming what it waited for and the observed state', async () => {
  const c = clock();
  const obs = new Observer(routes(empty).github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep });
  await rejects(
    obs.until(
      'A to close',
      () => undefined,
      5 * 60_000,
      () => 'o/exec#1 open [scope]',
    ),
    /timed out after 5 min waiting for A to close; observed: o\/exec#1 open \[scope\]/,
  );
});

test('jobs are read again each snapshot until they complete, then cached', async () => {
  let status = 'in_progress';
  const f = routes({ ...empty, 'GET /repos/o/exec/actions/runs/7/jobs': () => ({ jobs: [{ id: 1, status }] }) });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep });
  const count = () => f.calls.filter((x) => x.startsWith('GET /repos/o/exec/actions/runs/7/jobs')).length;
  await obs.next();
  await obs.jobs('o/exec', 7);
  await obs.jobs('o/exec', 7);
  equal(count(), 1);
  status = 'completed';
  await obs.fresh();
  await obs.jobs('o/exec', 7);
  await obs.fresh();
  await obs.jobs('o/exec', 7);
  equal(count(), 2);
});

test('hook rules from two scenarios at once are both kept (serialized read-modify-write) and read back', async () => {
  const vars = new Map<string, string>();
  const f = routes({
    'GET /repos/o/exec/actions/variables/E2E_CI_RULES': () =>
      vars.has('E2E_CI_RULES') ? { value: vars.get('E2E_CI_RULES') } : { status: 404, data: { message: 'nf' } },
    'POST /repos/o/exec/actions/variables': (b) => (
      vars.set(String(b?.name), String(b?.value)),
      { status: 201, data: {} }
    ),
    'PATCH /repos/o/exec/actions/variables/E2E_CI_RULES': (b) => (
      vars.set('E2E_CI_RULES', String(b?.value)),
      { status: 204 }
    ),
  });
  const k = new Kit(context(f.github), { tag: 'r1' });
  await Promise.all([
    k.hookRules('ci', [{ when: 'src/a.js', holdTag: 't' }]),
    k.hookRules('ci', [{ when: 'src/f.js', event: 'pull_request', require: { file: 'CHANGELOG.md', contains: 'f' } }]),
  ]);
  deepEqual(
    JSON.parse(vars.get('E2E_CI_RULES') ?? '[]').map((r: { when: string }) => r.when),
    ['src/a.js', 'src/f.js'],
  );
});

test('the baseline commits first, then creates the ruleset, then sets NIBFIN_PROVIDER, once', async () => {
  const order: string[] = [];
  let provider: string | undefined;
  const f = routes({
    'GET /repos/o/exec/contents/.nibfin.json': { status: 404, data: {} },
    'GET /repos/o/exec/contents/docs/agent/deliver.md': { status: 404, data: {} },
    'GET /repos/o/exec/git/ref/heads/main': { object: { sha: 'm0' } },
    'GET /repos/o/exec/git/commits/m0': { tree: { sha: 't0' } },
    'POST /repos/o/exec/git/trees': (b) => (
      order.push(`tree ${(b?.tree as { path: string }[]).map((e) => e.path).join(',')}`),
      { status: 201, data: { sha: 't1' } }
    ),
    'POST /repos/o/exec/git/commits': () => ({ status: 201, data: { sha: 'm1' } }),
    'PATCH /repos/o/exec/git/refs/heads/main': (b) => (
      order.push(`main ${String(b?.sha)} force=${String(b?.force)}`),
      {}
    ),
    'GET /repos/o/exec/rulesets': [],
    'POST /repos/o/exec/rulesets': (b) => (order.push(`ruleset ${String(b?.name)}`), { status: 201, data: { id: 1 } }),
    'GET /repos/o/exec/actions/variables/NIBFIN_PROVIDER': () =>
      provider ? { value: provider } : { status: 404, data: {} },
    'POST /repos/o/exec/actions/variables': (b) => (
      (provider = String(b?.value)),
      order.push(`var ${String(b?.name)}=${provider}`),
      { status: 201, data: {} }
    ),
  });
  const k = new Kit(context(f.github));
  await Promise.all([k.baseline(), k.baseline()]);
  deepEqual(order, [
    'tree .nibfin.json,docs/agent/deliver.md',
    'main m1 force=false',
    'ruleset e2e-ci',
    'var NIBFIN_PROVIDER=codex',
  ]);
});

test('the peer conflict is written while the PR is unmerged and not when it merged', async () => {
  let merged = false;
  const writes: string[] = [];
  const f = routes({
    'GET /repos/o/peer/pulls': () => [{ number: 3, merged_at: merged ? '2026-11-26T10:00:00Z' : null }],
    'GET /repos/o/peer/contents/src/sum.js': {
      content: Buffer.from('/** Adds two numbers. */\nexport function sum(a, b) {\n  return a + b;\n}\n').toString(
        'base64',
      ),
    },
    'GET /repos/o/peer/git/ref/heads/main': { object: { sha: 'p0' } },
    'GET /repos/o/peer/git/commits/p0': { tree: { sha: 't0' } },
    'POST /repos/o/peer/git/trees': (b) => (
      writes.push((b?.tree as { content: string }[])[0]?.content ?? ''),
      { status: 201, data: { sha: 't1' } }
    ),
    'POST /repos/o/peer/git/commits': { status: 201, data: { sha: 'p1' } },
    'PATCH /repos/o/peer/git/refs/heads/main': {},
  });
  const k = new Kit(context(f.github));
  equal((await writeConflict(k, 'o/peer', 'nibfin/issue-3', false))?.sha, 'p1');
  match(writes[0] ?? '', /^\/\*\* Adds a and b together\. \*\/\nexport function sum/);
  merged = true;
  equal(await writeConflict(k, 'o/peer', 'nibfin/issue-3', false), undefined);
  equal(await writeConflict(k, 'o/peer', 'nibfin/issue-3', true), undefined);
  equal(writes.length, 1);
  match(f.calls.find((x) => x.startsWith('GET /repos/o/peer/pulls')) ?? '', /head=o%3Anibfin%2Fissue-3/);
});

test('the peer Issue names its required final JSDoc line whatever main has', () => {
  const body = peerIssueBody('Returns the sum of a and b.');
  match(
    body,
    /the JSDoc line just above `export function sum` must end up exactly `\/\*\* Returns the sum of a and b\. \*\/`/,
  );
  match(body, /required final result whatever wording that line has on main/);
  match(body, /Change nothing else\./);
  equal(body.includes('Adds a and b together.'), false);
  match(body, /_This Issue is an automated nibfin-e2e fixture\._$/);
});

test('the request gate is waiting and names the Scope Issues not delivered', async () => {
  const table: Record<string, object> = {};
  for (const [repo, n] of SCOPE_ISSUES)
    table[`GET /repos/${repo}/issues/${n}`] = { state: 'closed', labels: [{ name: 'delivered' }] };
  table['GET /repos/taco3064/nibfin-core/issues/735'] = { state: 'open', labels: [{ name: 'scope' }] };
  table['GET /repos/taco3064/nibfin-core/issues/736'] = { state: 'closed', labels: [] };
  deepEqual(await scopeGate(routes(table).github), {
    status: 'waiting',
    reason:
      'the Scope stage is not delivered yet: taco3064/nibfin-core#735, taco3064/nibfin-core#736 not closed with delivered',
  });
  for (const n of [735, 736])
    table[`GET /repos/taco3064/nibfin-core/issues/${n}`] = { state: 'closed', labels: [{ name: 'delivered' }] };
  equal(await scopeGate(routes(table).github), undefined);
});

test('the secret scan reports locations, never values', async () => {
  const secret = 'github_pat_' + 'S'.repeat(40);
  deepEqual(leaks('x', `token ${secret}`, [secret]), ['x: a secret value', 'x: a token-shaped string']);
  deepEqual(leaks('x', 'plain *** text', [secret]), []);
  deepEqual(leaks('x', `ghp_${'a'.repeat(36)}`, []), ['x: a token-shaped string']);
  const f = routes({
    ...empty,
    'GET /repos/o/exec/issues': [{ number: 1, title: 't', body: `oops ${secret}` }],
    'GET /repos/o/exec/issues/comments': [{ html_url: 'https://c/1', body: 'fine' }],
    'GET /repos/o/exec/pulls/comments': [],
    'GET /repos/o/peer/issues/comments': [],
    'GET /repos/o/peer/pulls/comments': [],
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [
        { id: 5, display_title: 'Nibfin · o/exec#1 · shape', status: 'completed', created_at: '2026-11-26T10:00:00Z' },
      ],
    },
    'GET /repos/o/exec/actions/runs/5/jobs': {
      jobs: [
        {
          id: 8,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-11-26T10:00:00Z',
          runner_name: 'r1',
          labels: [],
        },
      ],
    },
    'GET /repos/o/exec/actions/jobs/8/logs': { status: 302, headers: { location: 'https://logs.example/8' } },
  });
  const fetchFn = f.fetchFn;
  const withLogs: typeof fetch = async (input, init) =>
    String(input).startsWith('https://logs.example/')
      ? new Response(`2026-11-26T10:00:00Z key sk-ant-${'x'.repeat(30)}\n`)
      : fetchFn(input, init);
  const { createGitHub } = await import('../../src/host/github.ts');
  const c = clock();
  const k = new Kit(
    context(
      createGitHub(() => 'tok', withLogs),
      { secretValues: () => [secret] },
    ),
    { now: c.now, sleep: c.sleep },
  );
  const { found, unreadable } = await scan(k);
  deepEqual(unreadable, []);
  deepEqual(found, [
    'o/exec#1 body: a secret value',
    'o/exec#1 body: a token-shaped string',
    'o/exec job 8 log (Nibfin · o/exec#1 · shape): a token-shaped string',
  ]);
  equal(
    found.some((x) => x.includes(secret)),
    false,
  );
  equal(credentialOutcome({ found, unreadable }).reason.includes(secret), false);
});

const ran = {
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-11-26T10:00:00Z',
  runner_name: 'r1',
  labels: [],
};

/** A Kit whose exec sandbox has one Nibfin run with the given jobs and job log routes. */
async function scanKit(jobs: object[], logs: Record<string, Handler | object>, logText = 'clean line') {
  const f = routes({
    ...empty,
    'GET /repos/o/exec/issues/comments': [],
    'GET /repos/o/exec/pulls/comments': [],
    'GET /repos/o/peer/issues/comments': [],
    'GET /repos/o/peer/pulls/comments': [],
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [
        { id: 5, display_title: 'Nibfin · o/exec#1 · shape', status: 'completed', created_at: '2026-11-26T10:00:00Z' },
      ],
    },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs },
    ...logs,
  });
  const fetchFn = f.fetchFn;
  const withLogs: typeof fetch = async (input, init) =>
    String(input).startsWith('https://logs.example/')
      ? new Response(`2026-11-26T10:00:00Z ${logText}\n`)
      : fetchFn(input, init);
  const { createGitHub } = await import('../../src/host/github.ts');
  const c = clock();
  return {
    f,
    k: new Kit(
      context(
        createGitHub(() => 'tok', withLogs),
        { secretValues: () => ['s3cret-value'] },
      ),
      { now: c.now, sleep: c.sleep },
    ),
  };
}

const logReads = (calls: string[], id: number) =>
  calls.filter((x) => x.startsWith(`GET /repos/o/exec/actions/jobs/${id}/logs`)).length;

test('the secret scan does not read the log of a job no runner took', async () => {
  const { f, k } = await scanKit(
    [
      { id: 11, status: 'completed', conclusion: 'skipped', started_at: null, runner_name: null, labels: [] },
      {
        id: 12,
        status: 'completed',
        conclusion: 'cancelled',
        started_at: '2026-11-26T10:00:00Z',
        runner_name: '',
        labels: [],
      },
    ],
    {},
  );
  deepEqual(await scan(k), { found: [], unreadable: [] });
  deepEqual([logReads(f.calls, 11), logReads(f.calls, 12)], [0, 0]);
});

test('an unreadable log of a job that ran is read twice and reported as unchecked, not as credentials found', async () => {
  const { f, k } = await scanKit([{ id: 9, ...ran }], {
    'GET /repos/o/exec/actions/jobs/9/logs': { status: 404, data: { message: 'Not Found' } },
  });
  const result = await scan(k);
  equal(logReads(f.calls, 9), 2);
  deepEqual(result.found, []);
  equal(result.unreadable.length, 1);
  match(result.unreadable[0] ?? '', /^o\/exec job 9 \(Nibfin · o\/exec#1 · shape\): .*actions\/jobs\/9\/logs.*404/);
  const out = credentialOutcome(result);
  equal(out.status, 'failed');
  match(out.reason, /^R3\.49: .*could not be checked.*o\/exec job 9/);
  equal(out.reason.includes('credentials found'), false);
});

test('a log that fails once and reads on the second try is scanned', async () => {
  let reads = 0;
  const { f, k } = await scanKit(
    [{ id: 9, ...ran }],
    {
      'GET /repos/o/exec/actions/jobs/9/logs': () =>
        ++reads === 1
          ? { status: 404, data: { message: 'Not Found' } }
          : { status: 302, headers: { location: 'https://logs.example/9' } },
    },
    'leaked s3cret-value',
  );
  deepEqual(await scan(k), { found: ['o/exec job 9 log (Nibfin · o/exec#1 · shape): a secret value'], unreadable: [] });
  equal(logReads(f.calls, 9), 2);
});

test('the credential verdict keeps leaks and unchecked logs apart, and passes a clean scan', () => {
  const both = credentialOutcome(
    { found: ['o/exec#1 body: a secret value'], unreadable: ['o/exec job 9 (Nibfin · o/exec#1 · shape): 404'] },
    ' (note)',
  );
  equal(both.status, 'failed');
  equal(
    both.reason,
    'R3.49: credentials found at o/exec#1 body: a secret value. Separately, these Nibfin job logs could not be checked, so the absence of credentials in them is not shown: o/exec job 9 (Nibfin · o/exec#1 · shape): 404 (note)',
  );
  deepEqual(credentialOutcome({ found: ['x: a token-shaped string'], unreadable: [] }), {
    status: 'failed',
    reason: 'R3.49: credentials found at x: a token-shaped string',
  });
  deepEqual(credentialOutcome({ found: [], unreadable: [] }, ' (note)'), {
    status: 'passed',
    reason:
      'no secret value or token-shaped string in Issues, PRs, comments, patches or Nibfin job logs of either sandbox (note)',
  });
});

test('a lifecycle scenario turns a throw into failed and redacts secret values', async () => {
  const s = lifecycle(
    { id: 'x', rules: ['R3.49'], run: async () => Promise.reject(new Error('saw tok-123 in a log')) },
    () => ({}) as Kit,
  );
  deepEqual(await s.run(context(routes({}).github, { secretValues: () => ['tok-123'] })), {
    status: 'failed',
    reason: 'saw *** in a log',
  });
  deepEqual([s.platforms, s.requires], [['linux'], ['nibfin']]);
  equal(redact('a b a', ['a']), '*** b ***');
});

test('a lifecycle scenario adds its own requirements after nibfin', () => {
  const run = async () => ({ status: 'passed' as const, reason: '' });
  deepEqual(lifecycle({ id: 'x', rules: ['R3.27'], run }).requires, ['nibfin']);
  deepEqual(lifecycle({ id: 'x', rules: ['R3.27'], requires: ['collaborator'], run }).requires, [
    'nibfin',
    'collaborator',
  ]);
});

test('the closing comment must name each PR and its merge commit', () => {
  const pr = { number: 7, html_url: 'https://github.com/o/exec/pull/7', merge_commit_sha: 'abcdef1234567' };
  const comment = (body: string) => ({ id: 1, body, created_at: '', updated_at: '', user: null, html_url: '' });
  deepEqual(closingProblems([comment('<!-- nibfin:closing --> Delivered in #7 (abcdef1)')], [pr]), []);
  deepEqual(closingProblems([comment('<!-- nibfin:closing --> Delivered')], [pr]), [
    'the closing comment does not name PR #7',
    'the closing comment does not name merge commit abcdef1 of PR #7',
  ]);
  deepEqual(closingProblems([comment('no marker')], [pr]), ['no marked closing comment']);
});

test('protected paths: the Proposal R3.46 list and the baseline role Skill file', () => {
  for (const p of [
    '.nibfin.json',
    '.nibfin/notes.md',
    '.rulesync/rules/style.md',
    '.github/workflows/ci.yml',
    'docs/agent/deliver.md',
    '.github/CODEOWNERS',
  ])
    equal(isProtected(p), true, p);
  for (const p of ['src/sum.js', 'docs/agent/other.md', 'sandbox/.nibfin.json.bak']) equal(isProtected(p), false, p);
});

test("settle waits only for the fixture's own runs; other Issues' running work does not hold it", async () => {
  const run = (id: number, title: string, status: string, repo = 'o/exec') => ({
    id,
    display_title: title,
    status,
    created_at: '2026-11-26T10:01:00Z',
    repo,
    name: 'x',
    event: 'e',
    conclusion: null,
    head_sha: 'h',
  });
  let mine = 'in_progress';
  const f = routes({
    ...empty,
    'GET /repos/o/exec/actions/runs': () => ({
      workflow_runs: [
        run(1, 'Nibfin · o/exec#5 · route', mine),
        run(2, 'Nibfin · o/exec#6 · deliver', 'in_progress'),
        run(3, 'Nibfin · o/exec#50 · shape', 'queued'),
      ],
    }),
    'GET /repos/o/peer/actions/runs': { workflow_runs: [run(4, 'Nibfin · o/exec#5 · wake', 'completed')] },
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const ofFive = k.runsOf('o/exec', 5);
  deepEqual(
    [
      run(1, 'Nibfin · o/exec#5 · route', 'x'),
      run(2, 'Nibfin · o/exec#6 · deliver', 'x'),
      run(3, 'Nibfin · o/exec#50 · shape', 'x'),
    ].map(ofFive),
    [true, false, false],
  );
  equal(ofFive(run(4, 'Nibfin · o/exec#5 · wake', 'completed', 'o/peer')), true);
  const after = Date.parse('2026-11-26T10:00:00Z');
  await rejects(k.settle('five', after, ofFive), /still running: Nibfin · o\/exec#5 · route \(in_progress\)/);
  mine = 'completed';
  const s = await k.settle('five', after, ofFive);
  equal(s.at - after >= 5 * 60_000, true);
});

test('runs once seen are kept; later listings cover only recent runs and unfinished older runs are re-read', async () => {
  const run = (id: number, status: string, created: string) => ({
    id,
    display_title: `Nibfin · o/exec#${id} · shape`,
    status,
    created_at: created,
  });
  let listing = [run(1, 'in_progress', '2026-11-26T10:00:30Z'), run(2, 'completed', '2026-11-26T10:00:40Z')];
  let one = run(1, 'in_progress', '2026-11-26T10:00:30Z');
  const f = routes({
    'GET /repos/o/exec/actions/runs': () => ({ data: { workflow_runs: listing } }),
    'GET /repos/o/exec/actions/runs/1': () => ({ data: one }),
    'GET /repos/o/exec/issues': [],
    'GET /repos/o/exec/pulls': [],
    'GET /rate_limit': {},
  });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, intervalMs: 60_000 });
  await obs.next();
  c.advance(30 * 60_000);
  listing = [run(3, 'queued', '2026-11-26T10:30:00Z')];
  one = run(1, 'completed', '2026-11-26T10:00:30Z');
  const s = await obs.fresh();
  deepEqual(s.runs.map((r) => [r.id, r.status]).sort(), [
    [1, 'completed'],
    [2, 'completed'],
    [3, 'queued'],
  ]);
  c.advance(30 * 60_000);
  await obs.fresh();
  const lists = f.calls.filter((x) => x.startsWith('GET /repos/o/exec/actions/runs?'));
  match(lists[0] ?? '', /created=%3E%3D2026-11-26T10%3A00%3A00Z/);
  match(lists[1] ?? '', /created=%3E%3D2026-11-26T10%3A00%3A00Z/, 'never before the start');
  match(lists[2] ?? '', /created=%3E%3D2026-11-26T10%3A20%3A00Z/, 'ten minutes before the previous listing');
  equal(
    f.calls.filter((x) => x === 'GET /repos/o/exec/actions/runs/1').length,
    1,
    'only the unfinished run missing from the listing is re-read',
  );
});

test('windows: agent windows leave out route and finish; all windows include them', async () => {
  const run = (id: number, stage: string) => ({
    id,
    display_title: `Nibfin · o/exec#5 · ${stage}`,
    status: 'completed',
    created_at: '2026-11-26T10:01:00Z',
  });
  const job = (id: number, labels: string[]) => ({
    id,
    status: 'completed',
    labels,
    runner_name: labels.includes('self-hosted') ? 'claude-1' : 'GitHub Actions 1',
    started_at: '2026-11-26T10:02:00Z',
    completed_at: '2026-11-26T10:03:00Z',
  });
  const f = routes({
    ...empty,
    'GET /repos/o/exec/actions/runs': {
      data: { workflow_runs: [run(1, 'route'), run(2, 'deliver'), run(3, 'finish')] },
    },
    'GET /repos/o/exec/actions/runs/1/jobs': { jobs: [job(11, ['ubuntu-24.04'])] },
    'GET /repos/o/exec/actions/runs/2/jobs': { jobs: [job(21, ['self-hosted', 'nibfin-42'])] },
    'GET /repos/o/exec/actions/runs/3/jobs': { jobs: [job(31, ['ubuntu-24.04'])] },
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const s = await k.obs.next();
  deepEqual(
    (await k.windows(s, 'o/exec', 5)).map((w) => [w.stage, w.jobId]),
    [['deliver', 21]],
  );
  deepEqual(
    (await k.windows(s, 'o/exec', 5, true)).map((w) => [w.stage, w.jobId]),
    [
      ['route', 11],
      ['deliver', 21],
      ['finish', 31],
    ],
  );
});

test('a failed read during a wait is logged and the wait goes on; the deadline names the last error', async () => {
  let fail = 2;
  const logs: string[] = [];
  const f = routes({
    ...empty,
    'GET /repos/o/exec/issues': () => (fail-- > 0 ? { status: 502, data: { message: 'Bad Gateway' } } : { data: [] }),
  });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], {
    since: c.now(),
    now: c.now,
    sleep: c.sleep,
    log: (m) => logs.push(m),
  });
  const started = c.now();
  equal(await obs.until('anything', () => true, 10 * 60_000), true);
  equal(c.now() - started >= 2 * 60_000, true, 'each retry of the read waits one interval');
  equal(logs.filter((l) => /a read while waiting for anything failed: .*502/.test(l)).length, 2);
  const broken = routes({ ...empty, 'GET /repos/o/exec/issues': { status: 502, data: { message: 'Bad Gateway' } } });
  const obs2 = new Observer(broken.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep });
  await rejects(
    obs2.until('B', () => true, 3 * 60_000),
    /timed out after 3 min waiting for B; last read error: GitHub GET \/repos\/o\/exec\/issues.* returned 502: Bad Gateway/,
  );
});

test('route jobs: skipped stage and finish jobs of a route run give no problems; a route job on a sandbox Runner gives one', async () => {
  const run = (id: number) => ({
    id,
    display_title: 'Nibfin · o/exec#5 · route',
    status: 'completed',
    created_at: '2026-11-26T10:01:00Z',
  });
  const skipped = (id: number, name: string, labels: string[]) => ({
    id,
    name,
    status: 'completed',
    conclusion: 'skipped',
    labels,
    runner_name: null,
    runner_group_name: null,
    started_at: '2026-11-26T10:02:00Z',
    completed_at: '2026-11-26T10:02:00Z',
  });
  const routeJob = (id: number, runner: string, group: string) => ({
    id,
    name: 'job / route',
    status: 'completed',
    conclusion: 'success',
    labels: ['ubuntu-24.04'],
    runner_name: runner,
    runner_group_name: group,
    started_at: '2026-11-26T10:02:00Z',
    completed_at: '2026-11-26T10:03:00Z',
  });
  const f = routes({
    ...empty,
    'GET /repos/o/exec/actions/runs': { data: { workflow_runs: [run(1), run(2), run(3)] } },
    'GET /repos/o/exec/actions/runs/1/jobs': {
      jobs: [
        routeJob(11, 'GitHub Actions 1000030606', 'GitHub Actions'),
        skipped(12, 'job / stage', ['self-hosted', 'nibfin-']),
        skipped(13, 'job / finish', ['ubuntu-24.04']),
      ],
    },
    'GET /repos/o/exec/actions/runs/2/jobs': {
      jobs: [{ ...skipped(21, 'job / route', ['ubuntu-24.04']), conclusion: 'cancelled' }],
    },
    'GET /repos/o/exec/actions/runs/3/jobs': { jobs: [routeJob(31, 'claude-1', 'GitHub Actions')] },
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const s = await k.obs.next();
  const route = await k.windowedJobs(s, 'o/exec', 5, ['route']);
  deepEqual(
    route.filter((j) => j.window).map((j) => j.id),
    [11, 31],
  );
  deepEqual(
    hostedRunProblems(
      route.filter((j) => j.run.id !== 3),
      ['claude-1'],
    ),
    [],
  );
  const problems = hostedRunProblems(route, ['claude-1']);
  equal(problems.length, 1);
  match(
    problems[0] as string,
    /Nibfin · o\/exec#5 · route \(run 3\) job job \/ route \(31\).*runner claude-1 in group GitHub Actions.*ran on the sandbox's registered Runner claude-1/,
  );
  match(stageSeen([], 'route'), /^no route job was seen$/);
  match(
    stageSeen(route, 'route'),
    /^route jobs seen: .*job \/ route \(11\).* window .*job \/ route \(21\) completed\/cancelled.* no window/,
  );
});
