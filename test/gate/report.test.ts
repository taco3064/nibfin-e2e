import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { report } from '../../src/gate/report.ts';
import type { ResultFile } from '../../src/gate/report.ts';
import { map, passed, scenario, step } from '../fixtures.ts';
import { FakeGate } from './fake.ts';
import type { FakeJob } from './fake.ts';

const E2E = 'taco3064/nibfin-e2e';
const env = { runId: '7', serverUrl: 'https://github.com', repository: E2E };
const scenarios = [
  scenario('a', ['R3.1', 'R3.2'], ['linux'], passed, ['nibfin']),
  scenario('b', ['R3.2', 'R5.13'], ['windows'], passed, ['nibfin']),
];
const steps = [step('host', passed), step('nibfin', passed, undefined, { requires: ['host'] })];
const registry = { entries: map, scenarios, steps };

const plan = (over: Record<string, unknown> = {}) => ({
  text: JSON.stringify({
    selection: { all: false, rules: [] },
    gaps: [],
    unselectedGaps: [],
    coverage: { passed: true, covered: 3, total: 3 },
    source: null,
    ...over,
  }),
});

function result(platform: string, runner: string | null, body: Record<string, unknown>): string {
  return JSON.stringify({ meta: { platform, runner }, provisioning: [], scenarios: [], teardown: [], ...body });
}

function gate(jobs: FakeJob[] = []) {
  const gh = new FakeGate();
  gh.runs.set('7', { created_at: '2026-11-27T09:00:00Z', run_attempt: 2 });
  gh.jobs.set('7', jobs);
  return gh;
}

const job = (name: string, conclusion: string | null, runner: string | null, status = 'completed') => ({
  name,
  status,
  conclusion,
  runner_name: runner,
  html_url: `https://github.com/${E2E}/actions/runs/7/job/${name}`,
  steps: [
    { name: 'checkout', conclusion: 'success' },
    { name: 'Run e2e', conclusion: 'failure' },
    { name: 'after', conclusion: 'skipped' },
  ],
});

test('root failures only: one request per failed step or scenario, merged across legs, with rules, runner and job link', async () => {
  const gh = gate([
    job('linux', 'failure', 'host-l'),
    job('windows', 'failure', 'host-w'),
    job('report', null, 'r', 'in_progress'),
  ]);
  const results: ResultFile[] = [
    {
      path: 'results/linux/result.json',
      text: result('linux', 'host-l', {
        provisioning: [
          { id: 'host', status: 'failed', reason: 'no ```podman' },
          { id: 'nibfin', status: 'failed', reason: 'provisioning step host failed', blockedBy: 'host' },
        ],
        scenarios: [
          {
            id: 'a',
            rules: ['R3.1', 'R3.2'],
            status: 'failed',
            reason: 'provisioning step nibfin failed',
            blockedBy: 'nibfin',
          },
        ],
      }),
    },
    {
      path: 'results/windows/result.json',
      text: result('windows', 'host-w', {
        provisioning: [{ id: 'host', status: 'failed', reason: 'no machine' }],
        scenarios: [
          { id: 'b', rules: ['R3.2', 'R5.13'], status: 'waiting', reason: 'not run: rule R5.13 is waiting on u' },
        ],
        teardown: [{ id: 'host', status: 'failed', reason: 'runner left' }],
      }),
    },
  ];
  const { output, failed } = await report({ gh, env, plan: plan(), results, registry });
  equal(failed, true);
  deepEqual(
    output.filed.map((f) => [f.title, f.decision]),
    [
      ['Provisioning failed: host', 'created'],
      ['Teardown failed: host', 'created'],
    ],
  );
  const body = gh.repo(E2E)[0]?.body ?? '';
  match(
    body,
    /^<!-- nibfin-e2e:run 7 -->\nThe release gate run https:\/\/github.com\/taco3064\/nibfin-e2e\/actions\/runs\/7 \(attempt 2\)/,
  );
  match(
    body,
    /### 1\. linux, runner `host-l`\n\n- Job: https:\/\/github.com\/taco3064\/nibfin-e2e\/actions\/runs\/7\/job\/linux\n- Related rules: R3\.1, R3\.2/,
  );
  match(body, /````text\nno ```podman\n````/);
  match(body, /### 2\. windows, runner `host-w`/);
  match(gh.repo(E2E)[1]?.body ?? '', /Related rules: R3\.2, R5\.13/);
  match(output.summary, /waiting, listed only/);
  deepEqual(gh.repo(E2E)[0]?.labels, ['request']);
});

test('a failed, cancelled or timed-out job without a result files "Job failed"; a passing run files nothing', async () => {
  const gh = gate([
    job('linux', 'cancelled', 'gone'),
    job('select', 'timed_out', null),
    job('ok', 'success', 'x'),
    job('windows', 'failure', 'host-w'),
  ]);
  const results: ResultFile[] = [
    {
      path: 'w.json',
      text: result('windows', 'host-w', { scenarios: [{ id: 'b', rules: ['R3.2'], status: 'passed', reason: 'ok' }] }),
    },
    { path: 'broken.json', error: 'EACCES' },
  ];
  const { output, failed } = await report({ gh, env, plan: plan(), results, registry });
  equal(failed, true);
  deepEqual(
    output.filed.map((f) => f.title),
    ['Job failed: linux', 'Job failed: select'],
  );
  const body = gh.repo(E2E)[0]?.body ?? '';
  match(body, /conclusion `cancelled`/);
  match(body, /```text\nRun e2e: failure\n```/);
  match(output.summary, /broken\.json \| no result \| EACCES/);

  const quiet = gate([job('linux', 'success', 'host-l')]);
  const ok = await report({
    gh: quiet,
    env,
    plan: plan(),
    results: [{ path: 'l.json', text: result('linux', 'host-l', {}) }],
    registry,
  });
  equal(ok.failed, false);
  deepEqual(quiet.writes, []);
});

test('a forged or malformed result counts as no result', async () => {
  const forged = [
    result('linux', 'host-l', { scenarios: [{ id: 'ghost', rules: ['R3.1'], status: 'failed', reason: 'x' }] }),
    result('linux', 'host-l', { scenarios: [{ id: 'a', rules: ['R9.9'], status: 'failed', reason: 'x' }] }),
    result('linux', 'host-l', { provisioning: [{ id: 'host', status: 'failed', reason: 'x', blockedBy: 'evil' }] }),
    result('solaris', 'host-l', {}),
    JSON.stringify({ error: { kind: 'usage', messages: ['bad'] } }),
    'not json',
  ];
  for (const text of forged) {
    const gh = gate([job('linux', 'failure', 'host-l')]);
    const { output } = await report({ gh, env, plan: plan(), results: [{ path: 'r.json', text }], registry });
    deepEqual(
      output.filed.map((f) => f.title),
      ['Job failed: linux'],
      text,
    );
    equal(output.decisions[0]?.decision, 'no result');
  }
});

test('selected gaps file "Coverage gap" and fail the run; unselected gaps are only listed outside --all', async () => {
  const gh = gate();
  const p = plan({
    gaps: [
      { id: 'R5.14', missing: ['macos'] },
      { id: 'R9.9', missing: 'not in coverage-map.json' },
    ],
    unselectedGaps: [{ id: 'R3.9', missingPlatforms: ['linux'] }],
    coverage: { passed: false, covered: 2, total: 3 },
    source: { issue: 'taco3064/nibfin-core#1', url: 'https://github.com/taco3064/nibfin-core/issues/1' },
  });
  const { output, failed } = await report({ gh, env, plan: p, results: [], registry });
  equal(failed, true);
  deepEqual(
    output.filed.map((f) => f.title),
    ['Coverage gap: R5.14', 'Coverage gap: R9.9'],
  );
  match(
    gh.repo(E2E)[0]?.body ?? '',
    /no scenario on macos\. It was selected by https:\/\/github.com\/taco3064\/nibfin-core\/issues\/1/,
  );
  match(gh.repo(E2E)[1]?.body ?? '', /R9\.9 is not in coverage-map\.json/);
  match(output.summary, /\| R3\.9 \| listed, not filed \|/);
  match(output.summary, /\| coverage check \| failed \| 2\/3 rules covered; fails the run only for --all/);
  deepEqual(output.coverage, { passed: false, covered: 2, total: 3 });

  const none = await report({
    gh: gate(),
    env,
    plan: plan({
      unselectedGaps: [{ id: 'R3.9', missingPlatforms: ['linux'] }],
      coverage: { passed: false, covered: 2, total: 3 },
    }),
    results: [],
    registry,
  });
  equal(none.failed, false);
  deepEqual(none.output.filed, []);
  match(none.output.summary, /\| R3\.9 \| listed, not filed \|/);
  match(none.output.summary, /\| coverage check \| failed \| 2\/3/);

  // A selected gap fails the run by itself, even when the whole map is covered.
  const selected = await report({
    gh: gate(),
    env,
    plan: plan({ gaps: [{ id: 'R5.13', missing: ['windows'] }] }),
    results: [],
    registry,
  });
  equal(selected.failed, true);
  deepEqual(
    selected.output.filed.map((f) => [f.title, f.decision]),
    [['Coverage gap: R5.13', 'created']],
  );
});

test('a delivered retest whose selected rules are all 〔不測〕 passes although other rules are uncovered', async () => {
  const gh = gate();
  const p = plan({
    selection: { all: false, rules: [] },
    unselectedGaps: [
      { id: 'R3.9', missingPlatforms: ['linux'] },
      { id: 'R5.13', missingPlatforms: ['windows'] },
    ],
    coverage: { passed: false, covered: 181, total: 209 },
    source: { issue: 'taco3064/gh-nibfin#457', url: 'https://github.com/taco3064/gh-nibfin/issues/457' },
  });
  const { output, failed } = await report({ gh, env, plan: p, results: [], registry });
  equal(failed, false);
  deepEqual(output.filed, []);
  deepEqual(gh.repo(E2E), []);
  match(output.summary, /\| R3\.9 \| listed, not filed \|/);
  match(output.summary, /\| R5\.13 \| listed, not filed \|/);
  match(output.summary, /\| coverage check \| failed \| 181\/209 rules covered; fails the run only for --all/);
});

test('an --all plan fails on an uncovered rule and passes at 100%', async () => {
  const uncovered = await report({
    gh: gate(),
    env,
    plan: plan({
      selection: { all: true },
      unselectedGaps: [{ id: 'R3.9', missingPlatforms: ['linux'] }],
      coverage: { passed: false, covered: 2, total: 3 },
    }),
    results: [],
    registry,
  });
  equal(uncovered.failed, true);
  deepEqual(uncovered.output.filed, []);
  match(uncovered.output.summary, /\| R3\.9 \| listed, not filed \|/);
  match(uncovered.output.summary, /\| coverage check \| failed \| 2\/3 rules covered \|/);

  const full = await report({ gh: gate(), env, plan: plan({ selection: { all: true } }), results: [], registry });
  equal(full.failed, false);
  match(full.output.summary, /\| coverage check \| passed \| 3\/3 rules covered \|/);
});

test('a missing or unusable plan is a decision and fails the coverage check', async () => {
  for (const p of [
    { error: 'no --plan given' },
    { text: '{"gaps": "x"}' },
    plan({ selection: undefined }),
    plan({ selection: { all: 'yes' } }),
  ]) {
    const { output, failed } = await report({ gh: gate(), env, plan: p, results: [], registry });
    equal(failed, true);
    equal(output.decisions[0]?.decision, 'no plan');
    equal(output.coverage, null);
  }
});

test('report runs once per leg, then once at the end, filing each request once', async () => {
  const gh = gate();
  const windows = job('run (windows-2025)', null, 'host-w', 'in_progress');
  const ubuntu = job('run (ubuntu-24.04)', null, 'host-l', 'in_progress');
  const select = job('select', 'success', 's');
  const winResult = {
    path: 'leg/result.json',
    text: result('windows', 'host-w', {
      provisioning: [{ id: 'host', status: 'failed', reason: 'gh nibfin runner add failed' }],
      teardown: [{ id: 'host', status: 'failed', reason: 'runner left' }],
    }),
  };
  const linResult = {
    path: 'leg/result.json',
    text: result('linux', 'host-l', { provisioning: [{ id: 'host', status: 'failed', reason: 'no podman' }] }),
  };
  const issues = () => gh.repo(E2E);
  const writes = () => gh.writes.splice(0);

  // (a) The windows leg ends first and files its own failures at once.
  gh.jobs.set('7', [select, windows]);
  const a = await report({
    gh,
    env,
    plan: { error: 'not read in leg mode' },
    results: [winResult],
    registry,
    leg: { runner: 'host-w' },
  });
  equal(a.failed, true);
  deepEqual(
    a.output.filed.map((f) => [f.title, f.decision]),
    [
      ['Provisioning failed: host', 'created'],
      ['Teardown failed: host', 'created'],
    ],
  );
  deepEqual(writes(), ['POST /repos/taco3064/nibfin-e2e/issues', 'POST /repos/taco3064/nibfin-e2e/issues']);
  const first = issues()[0]?.body ?? '';
  match(first, /\*\*Provisioning failed\*\* in 1 leg\./);
  match(first, /- Job: https:\/\/github.com\/taco3064\/nibfin-e2e\/actions\/runs\/7\/job\/run \(windows-2025\)/);
  match(first, /<!-- nibfin-e2e:run 7 leg windows -->$/);
  equal(a.output.coverage, null);
  match(a.output.summary, /\| plan \| left to the final report \|/);
  equal(/\| no plan \||\| coverage check \|/.test(a.output.summary), false);

  // (b) The ubuntu leg fails the same step: one comment with only its occurrence, no Job failed for windows.
  windows.status = 'completed';
  windows.conclusion = 'failure';
  gh.jobs.set('7', [select, windows, ubuntu]);
  const b = await report({
    gh,
    env,
    plan: { error: 'not read in leg mode' },
    results: [linResult],
    registry,
    leg: { runner: 'host-l' },
  });
  equal(b.failed, true);
  deepEqual(
    b.output.filed.map((f) => [f.title, f.decision, f.number]),
    [['Provisioning failed: host', 'commented', 1]],
  );
  deepEqual(writes(), ['POST /repos/taco3064/nibfin-e2e/issues/1/comments']);
  const comment = issues()[0]?.comments[0]?.body ?? '';
  match(comment, /^<!-- nibfin-e2e:run 7 -->\n/);
  match(
    comment,
    /\*\*Provisioning failed\*\* in 1 leg\.\n\n### 1\. linux, runner `host-l`\n\n- Job: https:\/\/github.com\/taco3064\/nibfin-e2e\/actions\/runs\/7\/job\/run \(ubuntu-24\.04\)/,
  );
  equal(comment.includes('windows'), false);
  match(comment, /<!-- nibfin-e2e:run 7 leg linux -->$/);

  // (c) The final report with both results and a plan gap files only the gap.
  ubuntu.status = 'completed';
  ubuntu.conclusion = 'failure';
  gh.jobs.set('7', [select, windows, ubuntu, job('report', null, 'r', 'in_progress')]);
  const finalResults = [
    { ...winResult, path: 'results/result-windows-2025/result.json' },
    { ...linResult, path: 'results/result-ubuntu-24.04/result.json' },
  ];
  const c = await report({
    gh,
    env,
    plan: plan({ gaps: [{ id: 'R5.13', missing: ['windows'] }] }),
    results: finalResults,
    registry,
  });
  equal(c.failed, true);
  deepEqual(
    c.output.filed.map((f) => [f.title, f.decision]),
    [
      ['Provisioning failed: host', 'already filed'],
      ['Teardown failed: host', 'already filed'],
      ['Coverage gap: R5.13', 'created'],
    ],
  );
  deepEqual(writes(), ['POST /repos/taco3064/nibfin-e2e/issues']);
  deepEqual(
    issues().map((i) => i.title),
    ['Provisioning failed: host', 'Teardown failed: host', 'Coverage gap: R5.13'],
  );
  equal(issues()[0]?.comments.length, 1);

  // (f) A re-run of either leg, or of the final report, writes nothing new.
  windows.status = ubuntu.status = 'in_progress';
  gh.jobs.set('7', [select, windows]);
  const again = await report({
    gh,
    env,
    plan: { error: 'not read in leg mode' },
    results: [winResult],
    registry,
    leg: { runner: 'host-w' },
  });
  deepEqual(
    again.output.filed.map((f) => f.decision),
    ['already filed', 'already filed'],
  );
  gh.jobs.set('7', [select, windows, ubuntu]);
  const againB = await report({
    gh,
    env,
    plan: { error: 'not read in leg mode' },
    results: [linResult],
    registry,
    leg: { runner: 'host-l' },
  });
  deepEqual(
    againB.output.filed.map((f) => f.decision),
    ['already filed'],
  );
  const againC = await report({
    gh,
    env,
    plan: plan({ gaps: [{ id: 'R5.13', missing: ['windows'] }] }),
    results: finalResults,
    registry,
  });
  deepEqual(
    againC.output.filed.map((f) => f.decision),
    ['already filed', 'already filed', 'already filed'],
  );
  deepEqual(writes(), []);
});

test('a leg without a usable result files "Job failed" for its own job once; a closed leg request is not filed again', async () => {
  const gh = gate();
  const windows = {
    ...job('run (windows-2025)', null, 'host-w', 'in_progress'),
    steps: [
      { name: 'checkout', conclusion: 'success' },
      { name: 'Run the harness', conclusion: 'failure' },
      { name: 'Upload result', conclusion: 'success' },
      { name: "File this leg's requests", conclusion: null },
    ],
  };
  const ubuntu = job('run (ubuntu-24.04)', null, 'host-l', 'in_progress');
  const empty = { path: 'leg/result.json', text: '' };
  const writes = () => gh.writes.splice(0);

  // (d) The leg has no usable result: its own in-progress job is filed, with the steps that failed so far.
  gh.jobs.set('7', [windows]);
  const d = await report({
    gh,
    env,
    plan: { error: 'not read in leg mode' },
    results: [empty],
    registry,
    leg: { runner: 'host-w' },
  });
  equal(d.failed, true);
  deepEqual(
    d.output.filed.map((f) => [f.title, f.decision]),
    [['Job failed: run (windows-2025)', 'created']],
  );
  const body = gh.repo(E2E)[0]?.body ?? '';
  match(body, /left no usable result; its leg filed this/);
  match(body, /- Steps that did not succeed so far:\n\n```text\nRun the harness: failure\n```/);
  match(body, /- Job: https:\/\/github.com\/taco3064\/nibfin-e2e\/actions\/runs\/7\/job\/run \(windows-2025\)/);
  writes();

  // The ubuntu leg then fails a step the windows leg never reached, but its step crashes before filing.
  // Meanwhile Scope closes the windows request.
  const filed = gh.repo(E2E)[0];
  if (filed) {
    filed.state = 'closed';
    filed.updated_at = gh.now();
  }

  // (e) The final report sees the failed windows job without a result: the closed request stays the
  // filing and no new issue is created; the ubuntu failure the leg could not file is filed now.
  windows.status = ubuntu.status = 'completed';
  windows.conclusion = ubuntu.conclusion = 'failure';
  gh.jobs.set('7', [windows, ubuntu, job('report', null, 'r', 'in_progress')]);
  const results = [
    { path: 'results/result-windows-2025/result.json', text: '' },
    {
      path: 'results/result-ubuntu-24.04/result.json',
      text: result('linux', 'host-l', { provisioning: [{ id: 'host', status: 'failed', reason: 'no podman' }] }),
    },
  ];
  const e = await report({ gh, env, plan: plan(), results, registry });
  equal(e.failed, true);
  deepEqual(
    e.output.filed.map((f) => [f.title, f.decision, f.number]),
    [
      ['Provisioning failed: host', 'created', 2],
      ['Job failed: run (windows-2025)', 'already filed', 1],
    ],
  );
  match(e.output.filed[1]?.reason ?? '', /#1, which is closed/);
  deepEqual(writes(), ['POST /repos/taco3064/nibfin-e2e/issues']);
  match(gh.repo(E2E)[1]?.body ?? '', /<!-- nibfin-e2e:run 7 leg linux -->$/);

  // A leg request for a platform closed meanwhile: the other leg's new occurrence goes on a new request.
  const p = gh.repo(E2E)[1];
  if (p) {
    p.state = 'closed';
    p.updated_at = gh.now();
  }
  const winHost = {
    path: 'w.json',
    text: result('windows', 'host-w', { provisioning: [{ id: 'host', status: 'failed', reason: 'no machine' }] }),
  };
  const linHost = results[1] as ResultFile;
  const later = await report({ gh, env, plan: plan(), results: [winHost, linHost], registry });
  deepEqual(
    later.output.filed.map((f) => [f.title, f.decision, f.number]),
    [['Provisioning failed: host', 'created', 3]],
  );
  const third = gh.repo(E2E)[2]?.body ?? '';
  match(third, /in 1 leg\.\n\n### 1\. windows/);
  equal(third.includes('leg linux'), false);
  match(third, /<!-- nibfin-e2e:run 7 leg windows -->$/);
  deepEqual(writes(), ['POST /repos/taco3064/nibfin-e2e/issues']);

  // A leg whose own job is not in the run files nothing and leaves it to the final report.
  const lost = await report({
    gh: gate([]),
    env,
    plan: { error: 'not read in leg mode' },
    results: [empty],
    registry,
    leg: { runner: 'gone' },
  });
  equal(lost.failed, false);
  deepEqual(lost.output.filed, []);
  match(lost.output.summary, /\| job on runner gone \| not found, left to the final report \|/);
});
