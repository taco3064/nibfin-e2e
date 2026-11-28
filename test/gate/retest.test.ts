import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../src/gate/cli.ts';
import { makePlan } from '../../src/gate/plan.ts';
import type { Plan, PlanRequest } from '../../src/gate/plan.ts';
import { lastRetestStart } from '../../src/gate/retest.ts';
import type { Env } from '../../src/host/exec.ts';
import { map, scenarios } from '../fixtures.ts';
import { FakeGate } from './fake.ts';
import type { FakeIssue, FakeWorkflowRun } from './fake.ts';

const CORE = 'taco3064/nibfin-core';
const GH = 'taco3064/gh-nibfin';
const E2E = 'taco3064/nibfin-e2e';
const SINCE = '2026-11-28T00:00:00Z';

function deliveredAt(gh: FakeGate, repo: string, closed: string, rules: string, over: Partial<FakeIssue> = {}) {
  return gh.addIssue(repo, {
    title: 'work',
    state: 'closed',
    labels: ['delivered'],
    closed_at: closed,
    updated_at: closed,
    comments: [
      {
        body: `<!-- nibfin:shape -->\n## Goal\nx\n\nProposal rules: ${rules}\n`,
        user: 'taco3064',
        updated_at: closed,
        html_url: `https://github.com/${repo}/issues/x#shape`,
      },
    ],
    ...over,
  });
}

async function plan(gh: FakeGate, request: PlanRequest): Promise<Plan> {
  const out = await makePlan(gh, map, scenarios, request);
  if ('usage' in out) throw new Error(out.usage.join('; '));
  return out.plan;
}

test('--delivered-since selects the union of every Issue delivered since then, across repositories', async () => {
  const gh = new FakeGate();
  deliveredAt(gh, CORE, '2026-11-28T01:00:00Z', 'R3.1, R5.14');
  deliveredAt(gh, CORE, '2026-11-27T23:59:59Z', 'R5.13'); // delivered before `since`
  gh.addIssue(CORE, {
    title: 'closed, not delivered',
    state: 'closed',
    labels: [],
    closed_at: '2026-11-28T02:00:00Z',
    updated_at: '2026-11-28T02:00:00Z',
  });
  gh.addIssue(CORE, {
    title: 'a pull request',
    state: 'closed',
    labels: ['delivered'],
    pull_request: true,
    closed_at: '2026-11-28T02:00:00Z',
    updated_at: '2026-11-28T02:00:00Z',
  });
  // Updated after `since`, but closed before it.
  deliveredAt(gh, GH, '2026-11-27T12:00:00Z', 'R3.2', { updated_at: '2026-11-28T05:00:00Z' });
  deliveredAt(gh, GH, '2026-11-28T00:00:00Z', 'R5.14, R3.2');
  const p = await plan(gh, { mode: 'delivered-since', since: SINCE });
  equal(p.mode, 'delivered-since');
  equal(p.since, SINCE);
  equal(p.source, null);
  deepEqual(
    p.sources.map((s) => [s.issue, s.state]),
    [
      [`${CORE}#1`, 'line'],
      [`${GH}#2`, 'line'],
    ],
  );
  deepEqual(p.selection, { all: false, rules: ['R3.1', 'R5.14', 'R3.2'] });
  deepEqual(p.gaps, [
    {
      id: 'R5.14',
      missing: ['macos'],
      selectedBy: [`https://github.com/${CORE}/issues/1`, `https://github.com/${GH}/issues/2`],
    },
  ]);
  equal(p.execute, true);
  match(p.summary, /every Issue delivered since \| closed with .delivered. at or after 2026-11-28T00:00:00Z: taco3064\/nibfin-core#1, taco3064\/gh-nibfin#2/);
  match(p.summary, /\| taco3064\/gh-nibfin#2 \| selected from the Shape line \|/);
  deepEqual(gh.writes, []);
});

test('--delivered-since with no delivered Issue says so and does not execute', async () => {
  const gh = new FakeGate();
  deliveredAt(gh, E2E, '2026-11-27T00:00:00Z', 'R3.1');
  const p = await plan(gh, { mode: 'delivered-since', since: SINCE });
  deepEqual(p.sources, []);
  deepEqual(p.selection, { all: false, rules: [] });
  equal(p.execute, false);
  deepEqual(p.gaps, []);
  match(p.summary, /no delivered Issue found \| no Issue was closed with .delivered. at or after 2026-11-28T00:00:00Z/);
});

test('--delivered keeps its plan and lists its one Issue in sources', async () => {
  const gh = new FakeGate();
  deliveredAt(gh, CORE, '2026-11-28T01:00:00Z', 'R5.14');
  const p = await plan(gh, { mode: 'delivered', ref: { repo: CORE, number: 1 } });
  equal(p.source?.issue, `${CORE}#1`);
  deepEqual(p.sources, [p.source]);
  equal(p.since, undefined);
  deepEqual(p.gaps, [{ id: 'R5.14', missing: ['macos'] }]);
});

const run = (id: number, over: Partial<FakeWorkflowRun> = {}): FakeWorkflowRun => ({
  id,
  event: 'repository_dispatch',
  status: 'completed',
  conclusion: 'success',
  display_title: `e2e · retest ${CORE}#${id}`,
  created_at: '2026-11-27T10:00:00Z',
  run_started_at: '2026-11-27T10:00:00Z',
  ...over,
});

test('lastRetestStart skips cancelled, Proposal-update, unfinished and own runs, and takes the earlier time', async () => {
  const gh = new FakeGate();
  const filler = Array.from({ length: 100 }, (_, i) => run(1000 + i, { conclusion: 'cancelled' }));
  gh.workflowRuns.set(`${E2E}/e2e.yml`, [
    run(1, { status: 'in_progress', conclusion: null }),
    run(2, { conclusion: 'success', display_title: 'e2e · Proposal updated' }),
    run(3, { conclusion: 'failure' }),
    run(4, { event: 'workflow_dispatch', display_title: 'e2e · retest manual' }),
    ...filler,
    run(5, { conclusion: 'failure', created_at: '2026-11-26T08:00:00Z', run_started_at: '2026-11-26T09:30:00Z' }),
  ]);
  equal(await lastRetestStart(gh, '3'), '2026-11-26T08:00:00.000Z');
  equal(await lastRetestStart(gh), '2026-11-27T10:00:00.000Z');
  equal(
    gh.reads.filter((r) => r.includes('/actions/workflows/e2e.yml/runs?event=repository_dispatch&status=completed'))
      .length,
    3,
  );
  gh.workflowRuns.set(`${E2E}/e2e.yml`, [run(6, { conclusion: 'cancelled' }), run(7, { display_title: 'e2e · Proposal updated' })]);
  equal(await lastRetestStart(gh), null);
});

const env: Env = {
  NIBFIN_GITHUB_TOKEN: 'owner-secret',
  GITHUB_RUN_ID: '42',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: E2E,
};

async function gate(argv: string[], gh = new FakeGate()) {
  let stdout = '';
  let stderr = '';
  const clients: boolean[] = [];
  const code = await main(argv, {
    env,
    github: (token, reads) => (token(), clients.push(reads !== undefined), gh),
    loadMap: () => ({ entries: map, errors: [] }),
    scenarios,
    steps: [],
    readFile: () => {
      throw new Error('not read');
    },
    readResults: () => [],
    sources: () => [],
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
  });
  equal(stdout.includes('owner-secret') || stderr.includes('owner-secret'), false);
  return { code, json: JSON.parse(stdout), stderr, gh, clients };
}

test('select --delivered --since-last-retest plans from the last retest, or falls back to the one Issue', async () => {
  const gh = new FakeGate();
  deliveredAt(gh, CORE, '2026-11-28T01:00:00Z', 'R3.1');
  deliveredAt(gh, GH, '2026-11-28T03:00:00Z', 'R3.2');
  const fallback = await gate(['select', '--delivered', `${CORE}#1`, '--since-last-retest'], gh);
  equal(fallback.code, 0);
  equal(fallback.json.mode, 'delivered');
  deepEqual(fallback.json.selection, { all: false, rules: ['R3.1'] });
  match(fallback.json.summary, /\| since \| only taco3064\/nibfin-core#1 \| --since-last-retest: no completed, non-cancelled retest run was found \|/);
  deepEqual(fallback.clients, [true]);

  gh.workflowRuns.set(`${E2E}/e2e.yml`, [
    run(42, { created_at: '2026-11-28T02:00:00Z', run_started_at: '2026-11-28T02:00:00Z' }),
    run(41, { created_at: '2026-11-28T00:30:00Z', run_started_at: '2026-11-28T00:30:00Z' }),
  ]);
  const merged = await gate(['select', '--delivered', `${CORE}#1`, '--since-last-retest'], gh);
  equal(merged.code, 0);
  equal(merged.json.mode, 'delivered-since');
  equal(merged.json.since, '2026-11-28T00:30:00.000Z');
  deepEqual(merged.json.selection, { all: false, rules: ['R3.1', 'R3.2'] });
  deepEqual(
    merged.json.sources.map((s: { issue: string }) => s.issue),
    [`${CORE}#1`, `${GH}#1`],
  );

  const direct = await gate(['select', '--delivered-since', '2026-11-28T02:00:00.5Z'], gh);
  equal(direct.code, 0);
  deepEqual(direct.json.selection, { all: false, rules: ['R3.2'] });
});

test('bad --delivered-since values and flag combinations are usage errors before any GitHub call', async () => {
  const cases: [string[], RegExp][] = [
    [['select', '--delivered-since', '2026-11-28'], /expected an ISO 8601 UTC time/],
    [['select', '--delivered-since', '2026-11-28T00:00:00+08:00'], /expected an ISO 8601 UTC time/],
    [['select', '--delivered-since', '2026-13-40T00:00:00Z'], /expected an ISO 8601 UTC time/],
    [['select', '--delivered-since', '2026-11-28T00:00:00Z', '--all'], /exactly one of/],
    [['select', '--delivered-since', '2026-11-28T00:00:00Z', '--delivered', `${CORE}#1`], /exactly one of/],
    [['select', '--since-last-retest', '--all'], /--since-last-retest needs --delivered/],
    [['select', '--since-last-retest', '--delivered-since', '2026-11-28T00:00:00Z'], /--since-last-retest needs --delivered/],
  ];
  for (const [argv, expected] of cases) {
    const r = await gate(argv);
    equal(r.code, 2, argv.join(' '));
    match(r.json.error.messages.join('\n'), expected, argv.join(' '));
    deepEqual([r.gh.reads, r.clients], [[], []], argv.join(' '));
  }
});
