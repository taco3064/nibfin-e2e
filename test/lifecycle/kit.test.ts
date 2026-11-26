import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { Kit, lifecycle, redact } from '../../scenarios/lifecycle/kit.ts';
import { Observer } from '../../scenarios/lifecycle/observe.ts';
import { closingProblems } from '../../scenarios/lifecycle/phase1.ts';
import { isProtected, writeConflict } from '../../scenarios/lifecycle/phase2-fixtures.ts';
import { leaks, scan } from '../../scenarios/lifecycle/phase3.ts';
import { SCOPE_ISSUES, scopeGate } from '../../scenarios/lifecycle/requests.ts';
import { clock, context, routes } from './fake.ts';

const empty = { 'GET /repos/o/exec/actions/runs': { workflow_runs: [] }, 'GET /repos/o/exec/issues': [], 'GET /repos/o/exec/pulls': [], 'GET /repos/o/peer/actions/runs': { workflow_runs: [] }, 'GET /repos/o/peer/issues': [], 'GET /repos/o/peer/pulls': [], 'GET /rate_limit': { resources: { core: { remaining: 4999 } } } };

test('waiters share one snapshot, refreshed at most once per interval', async () => {
  const f = routes(empty);
  const c = clock();
  const obs = new Observer(f.github, ['o/exec', 'o/peer'], { since: c.now(), now: c.now, sleep: c.sleep, intervalMs: 60_000 });
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
  await rejects(obs.until('A to close', () => undefined, 5 * 60_000, () => 'o/exec#1 open [scope]'), /timed out after 5 min waiting for A to close; observed: o\/exec#1 open \[scope\]/);
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
    'GET /repos/o/exec/actions/variables/E2E_CI_RULES': () => (vars.has('E2E_CI_RULES') ? { value: vars.get('E2E_CI_RULES') } : { status: 404, data: { message: 'nf' } }),
    'POST /repos/o/exec/actions/variables': (b) => (vars.set(String(b?.name), String(b?.value)), { status: 201, data: {} }),
    'PATCH /repos/o/exec/actions/variables/E2E_CI_RULES': (b) => (vars.set('E2E_CI_RULES', String(b?.value)), { status: 204 }),
  });
  const k = new Kit(context(f.github), { tag: 'r1' });
  await Promise.all([k.hookRules('ci', [{ when: 'src/a.js', holdTag: 't' }]), k.hookRules('ci', [{ when: 'src/f.js', event: 'pull_request', require: { file: 'CHANGELOG.md', contains: 'f' } }])]);
  deepEqual(JSON.parse(vars.get('E2E_CI_RULES') ?? '[]').map((r: { when: string }) => r.when), ['src/a.js', 'src/f.js']);
});

test('the baseline commits first, then creates the ruleset, then sets NIBFIN_PROVIDER, once', async () => {
  const order: string[] = [];
  let provider: string | undefined;
  const f = routes({
    'GET /repos/o/exec/contents/.nibfin.json': { status: 404, data: {} },
    'GET /repos/o/exec/contents/docs/agent/deliver.md': { status: 404, data: {} },
    'GET /repos/o/exec/git/ref/heads/main': { object: { sha: 'm0' } },
    'GET /repos/o/exec/git/commits/m0': { tree: { sha: 't0' } },
    'POST /repos/o/exec/git/trees': (b) => (order.push(`tree ${(b?.tree as { path: string }[]).map((e) => e.path).join(',')}`), { status: 201, data: { sha: 't1' } }),
    'POST /repos/o/exec/git/commits': () => ({ status: 201, data: { sha: 'm1' } }),
    'PATCH /repos/o/exec/git/refs/heads/main': (b) => (order.push(`main ${String(b?.sha)} force=${String(b?.force)}`), {}),
    'GET /repos/o/exec/rulesets': [],
    'POST /repos/o/exec/rulesets': (b) => (order.push(`ruleset ${String(b?.name)}`), { status: 201, data: { id: 1 } }),
    'GET /repos/o/exec/actions/variables/NIBFIN_PROVIDER': () => (provider ? { value: provider } : { status: 404, data: {} }),
    'POST /repos/o/exec/actions/variables': (b) => ((provider = String(b?.value)), order.push(`var ${String(b?.name)}=${provider}`), { status: 201, data: {} }),
  });
  const k = new Kit(context(f.github));
  await Promise.all([k.baseline(), k.baseline()]);
  deepEqual(order, ['tree .nibfin.json,docs/agent/deliver.md', 'main m1 force=false', 'ruleset e2e-ci', 'var NIBFIN_PROVIDER=codex']);
});

test('the peer conflict is written while the PR is unmerged and not when it merged', async () => {
  let merged = false;
  const writes: string[] = [];
  const f = routes({
    'GET /repos/o/peer/pulls': () => [{ number: 3, merged_at: merged ? '2026-11-26T10:00:00Z' : null }],
    'GET /repos/o/peer/contents/src/sum.js': { content: Buffer.from('/** Adds two numbers. */\nexport function sum(a, b) {\n  return a + b;\n}\n').toString('base64') },
    'GET /repos/o/peer/git/ref/heads/main': { object: { sha: 'p0' } },
    'GET /repos/o/peer/git/commits/p0': { tree: { sha: 't0' } },
    'POST /repos/o/peer/git/trees': (b) => (writes.push((b?.tree as { content: string }[])[0]?.content ?? ''), { status: 201, data: { sha: 't1' } }),
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

test('the request gate is waiting and names the Scope Issues not delivered', async () => {
  const table: Record<string, object> = {};
  for (const [repo, n] of SCOPE_ISSUES) table[`GET /repos/${repo}/issues/${n}`] = { state: 'closed', labels: [{ name: 'delivered' }] };
  table['GET /repos/taco3064/nibfin-core/issues/735'] = { state: 'open', labels: [{ name: 'scope' }] };
  table['GET /repos/taco3064/nibfin-core/issues/736'] = { state: 'closed', labels: [] };
  deepEqual(await scopeGate(routes(table).github), {
    status: 'waiting',
    reason: 'the Scope stage is not delivered yet: taco3064/nibfin-core#735, taco3064/nibfin-core#736 not closed with delivered',
  });
  for (const n of [735, 736]) table[`GET /repos/taco3064/nibfin-core/issues/${n}`] = { state: 'closed', labels: [{ name: 'delivered' }] };
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
    'GET /repos/o/exec/actions/runs': { workflow_runs: [{ id: 5, display_title: 'Nibfin · o/exec#1 · shape', status: 'completed', created_at: '2026-11-26T10:00:00Z' }] },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [{ id: 8, status: 'completed' }] },
    'GET /repos/o/exec/actions/jobs/8/logs': { status: 302, headers: { location: 'https://logs.example/8' } },
  });
  const fetchFn = f.fetchFn;
  const withLogs: typeof fetch = async (input, init) => (String(input).startsWith('https://logs.example/') ? new Response(`2026-11-26T10:00:00Z key sk-ant-${'x'.repeat(30)}\n`) : fetchFn(input, init));
  const { createGitHub } = await import('../../src/host/github.ts');
  const c = clock();
  const k = new Kit(context(createGitHub(() => 'tok', withLogs), { secretValues: () => [secret] }), { now: c.now, sleep: c.sleep });
  const found = await scan(k);
  deepEqual(found, ['o/exec#1 body: a secret value', 'o/exec#1 body: a token-shaped string', 'o/exec job 8 log (Nibfin · o/exec#1 · shape): a token-shaped string']);
  equal(found.some((x) => x.includes(secret)), false);
});

test('a lifecycle scenario turns a throw into failed and redacts secret values', async () => {
  const s = lifecycle({ id: 'x', rules: ['R3.49'], run: async () => Promise.reject(new Error('saw tok-123 in a log')) }, () => ({}) as Kit);
  deepEqual(await s.run(context(routes({}).github, { secretValues: () => ['tok-123'] })), { status: 'failed', reason: 'saw *** in a log' });
  deepEqual([s.platforms, s.requires], [['linux'], ['nibfin']]);
  equal(redact('a b a', ['a']), '*** b ***');
});

test('the closing comment must name each PR and its merge commit', () => {
  const pr = { number: 7, html_url: 'https://github.com/o/exec/pull/7', merge_commit_sha: 'abcdef1234567' };
  const comment = (body: string) => ({ id: 1, body, created_at: '', updated_at: '', user: null, html_url: '' });
  deepEqual(closingProblems([comment('<!-- nibfin:closing --> Delivered in #7 (abcdef1)')], [pr]), []);
  deepEqual(closingProblems([comment('<!-- nibfin:closing --> Delivered')], [pr]), ['the closing comment does not name PR #7', 'the closing comment does not name merge commit abcdef1 of PR #7']);
  deepEqual(closingProblems([comment('no marker')], [pr]), ['no marked closing comment']);
});

test('protected paths: the Proposal R3.46 list and the baseline role Skill file', () => {
  for (const p of ['.nibfin.json', '.nibfin/notes.md', '.rulesync/rules/style.md', '.github/workflows/ci.yml', 'docs/agent/deliver.md', '.github/CODEOWNERS']) equal(isProtected(p), true, p);
  for (const p of ['src/sum.js', 'docs/agent/other.md', 'sandbox/.nibfin.json.bak']) equal(isProtected(p), false, p);
});
