import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { report } from '../../src/gate/report.ts';
import type { ResultFile } from '../../src/gate/report.ts';
import { map, passed, scenario, step } from '../fixtures.ts';
import { FakeGate } from './fake.ts';
import type { FakeJob } from './fake.ts';

const E2E = 'taco3064/nibfin-e2e';
const env = { runId: '7', serverUrl: 'https://github.com', repository: E2E };
const scenarios = [scenario('a', ['R3.1', 'R3.2'], ['linux'], passed, ['nibfin']), scenario('b', ['R3.2', 'R5.13'], ['windows'], passed, ['nibfin'])];
const steps = [step('host', passed), step('nibfin', passed, undefined, { requires: ['host'] })];
const registry = { entries: map, scenarios, steps };

const plan = (over: Record<string, unknown> = {}) => ({
  text: JSON.stringify({ gaps: [], unselectedGaps: [], coverage: { passed: true, covered: 3, total: 3 }, source: null, ...over }),
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
  steps: [{ name: 'checkout', conclusion: 'success' }, { name: 'Run e2e', conclusion: 'failure' }, { name: 'after', conclusion: 'skipped' }],
});

test('root failures only: one request per failed step or scenario, merged across legs, with rules, runner and job link', async () => {
  const gh = gate([job('linux', 'failure', 'host-l'), job('windows', 'failure', 'host-w'), job('report', null, 'r', 'in_progress')]);
  const results: ResultFile[] = [
    {
      path: 'results/linux/result.json',
      text: result('linux', 'host-l', {
        provisioning: [
          { id: 'host', status: 'failed', reason: 'no ```podman' },
          { id: 'nibfin', status: 'failed', reason: 'provisioning step host failed', blockedBy: 'host' },
        ],
        scenarios: [{ id: 'a', rules: ['R3.1', 'R3.2'], status: 'failed', reason: 'provisioning step nibfin failed', blockedBy: 'nibfin' }],
      }),
    },
    {
      path: 'results/windows/result.json',
      text: result('windows', 'host-w', {
        provisioning: [{ id: 'host', status: 'failed', reason: 'no machine' }],
        scenarios: [{ id: 'b', rules: ['R3.2', 'R5.13'], status: 'waiting', reason: 'not run: rule R5.13 is waiting on u' }],
        teardown: [{ id: 'host', status: 'failed', reason: 'runner left' }],
      }),
    },
  ];
  const { output, failed } = await report({ gh, env, plan: plan(), results, registry });
  equal(failed, true);
  deepEqual(output.filed.map((f) => [f.title, f.decision]), [
    ['Provisioning failed: host', 'created'],
    ['Teardown failed: host', 'created'],
  ]);
  const body = gh.repo(E2E)[0]?.body ?? '';
  match(body, /^<!-- nibfin-e2e:run 7 -->\nThe release gate run https:\/\/github.com\/taco3064\/nibfin-e2e\/actions\/runs\/7 \(attempt 2\)/);
  match(body, /### 1\. linux, runner `host-l`\n\n- Job: https:\/\/github.com\/taco3064\/nibfin-e2e\/actions\/runs\/7\/job\/linux\n- Related rules: R3\.1, R3\.2/);
  match(body, /````text\nno ```podman\n````/);
  match(body, /### 2\. windows, runner `host-w`/);
  match(gh.repo(E2E)[1]?.body ?? '', /Related rules: R3\.2, R5\.13/);
  match(output.summary, /waiting, listed only/);
  deepEqual(gh.repo(E2E)[0]?.labels, ['request']);
});

test('a failed, cancelled or timed-out job without a result files "Job failed"; a passing run files nothing', async () => {
  const gh = gate([job('linux', 'cancelled', 'gone'), job('select', 'timed_out', null), job('ok', 'success', 'x'), job('windows', 'failure', 'host-w')]);
  const results: ResultFile[] = [
    { path: 'w.json', text: result('windows', 'host-w', { scenarios: [{ id: 'b', rules: ['R3.2'], status: 'passed', reason: 'ok' }] }) },
    { path: 'broken.json', error: 'EACCES' },
  ];
  const { output, failed } = await report({ gh, env, plan: plan(), results, registry });
  equal(failed, true);
  deepEqual(output.filed.map((f) => f.title), ['Job failed: linux', 'Job failed: select']);
  const body = gh.repo(E2E)[0]?.body ?? '';
  match(body, /conclusion `cancelled`/);
  match(body, /```text\nRun e2e: failure\n```/);
  match(output.summary, /broken\.json \| no result \| EACCES/);

  const quiet = gate([job('linux', 'success', 'host-l')]);
  const ok = await report({ gh: quiet, env, plan: plan(), results: [{ path: 'l.json', text: result('linux', 'host-l', {}) }], registry });
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
    deepEqual(output.filed.map((f) => f.title), ['Job failed: linux'], text);
    equal(output.decisions[0]?.decision, 'no result');
  }
});

test('selected gaps file "Coverage gap"; unselected gaps are listed and fail the coverage check', async () => {
  const gh = gate();
  const p = plan({
    gaps: [{ id: 'R5.14', missing: ['macos'] }, { id: 'R9.9', missing: 'not in coverage-map.json' }],
    unselectedGaps: [{ id: 'R3.9', missingPlatforms: ['linux'] }],
    coverage: { passed: false, covered: 2, total: 3 },
    source: { issue: 'taco3064/nibfin-core#1', url: 'https://github.com/taco3064/nibfin-core/issues/1' },
  });
  const { output, failed } = await report({ gh, env, plan: p, results: [], registry });
  equal(failed, true);
  deepEqual(output.filed.map((f) => f.title), ['Coverage gap: R5.14', 'Coverage gap: R9.9']);
  match(gh.repo(E2E)[0]?.body ?? '', /no scenario on macos\. It was selected by https:\/\/github.com\/taco3064\/nibfin-core\/issues\/1/);
  match(gh.repo(E2E)[1]?.body ?? '', /R9\.9 is not in coverage-map\.json/);
  match(output.summary, /\| R3\.9 \| listed, not filed \|/);
  match(output.summary, /\| coverage check \| failed \| 2\/3/);
  deepEqual(output.coverage, { passed: false, covered: 2, total: 3 });

  const none = await report({ gh: gate(), env, plan: plan({ unselectedGaps: [{ id: 'R3.9', missingPlatforms: ['linux'] }], coverage: { passed: false, covered: 2, total: 3 } }), results: [], registry });
  equal(none.failed, true);
  deepEqual(none.output.filed, []);
});

test('a missing or unusable plan is a decision and fails the coverage check', async () => {
  for (const p of [{ error: 'no --plan given' }, { text: '{"gaps": "x"}' }]) {
    const { output, failed } = await report({ gh: gate(), env, plan: p, results: [], registry });
    equal(failed, true);
    equal(output.decisions[0]?.decision, 'no plan');
    equal(output.coverage, null);
  }
});
