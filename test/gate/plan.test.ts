import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { makePlan } from '../../src/gate/plan.ts';
import type { Plan, PlanRequest } from '../../src/gate/plan.ts';
import { map, scenarios } from '../fixtures.ts';
import { FakeGate } from './fake.ts';
import type { FakeIssue } from './fake.ts';

const CORE = 'taco3064/nibfin-core';
const GH = 'taco3064/gh-nibfin';

function delivered(gh: FakeGate, body: string, comments: FakeIssue['comments'] = []) {
  return gh.addIssue(CORE, { title: 'work', state: 'closed', labels: ['delivered'], body, comments });
}

const shape = (text: string, user = 'taco3064') => ({
  body: `<!-- nibfin:shape -->\n## Goal\n${text}\n`,
  user,
  updated_at: '2026-11-26T00:00:00Z',
  html_url: 'https://github.com/taco3064/nibfin-core/issues/1#shape',
});

async function plan(gh: FakeGate, request: PlanRequest): Promise<Plan> {
  const out = await makePlan(gh, map, scenarios, request);
  if ('usage' in out) throw new Error(out.usage.join('; '));
  return out.plan;
}

const ref = { mode: 'delivered' as const, ref: { repo: CORE, number: 1 } };

test('a delivered Issue selects the Shape line; rules cited by open scope Issues wait; uncovered selected rules are gaps', async () => {
  const gh = new FakeGate();
  delivered(gh, '## Authority\nR5.13', [shape('Proposal rules: R0.1, R3.1, R3.2, R5.14, R9.9')]);
  gh.addIssue(GH, { title: 'scope', labels: ['scope'], body: '## Authority\nProposal R3.2' });
  gh.addIssue(GH, { title: 'a PR', labels: ['scope'], body: '## Authority\nR3.1', pull_request: true });
  gh.addIssue(CORE, { title: 'closed scope', state: 'closed', labels: ['scope'], body: '## Authority\nR3.1' });
  const p = await plan(gh, ref);
  equal(p.mode, 'delivered');
  equal(p.source?.state, 'line');
  equal(p.source?.shape, 'https://github.com/taco3064/nibfin-core/issues/1#shape');
  deepEqual(p.selection, { all: false, rules: ['R3.1', 'R5.14'] });
  deepEqual(p.waiting, [{ id: 'R3.2', issues: ['https://github.com/taco3064/gh-nibfin/issues/1'] }]);
  deepEqual(p.excluded, [{ id: 'R0.1', reason: '文件定位' }]);
  deepEqual(p.unknown, ['R9.9']);
  deepEqual(p.gaps, [
    { id: 'R9.9', missing: 'not in coverage-map.json' },
    { id: 'R5.14', missing: ['macos'] },
  ]);
  deepEqual(p.unselectedGaps, []);
  deepEqual(p.coverage, { passed: false, covered: 3, total: 4 });
  equal(p.execute, true);
  match(p.summary, /^## Gate plan/);
  match(p.summary, /\| R3\.2 \| waiting \|/);
});

test('`none` selects nothing and does not execute; unselected gaps are listed only', async () => {
  const gh = new FakeGate();
  delivered(gh, '## Authority\nR3.1', [shape('Proposal rules: none')]);
  const p = await plan(gh, ref);
  equal(p.source?.state, 'none');
  deepEqual(p.selection, { all: false, rules: [] });
  equal(p.execute, false);
  deepEqual(p.gaps, []);
  deepEqual(p.unselectedGaps, [{ id: 'R5.14', missingPlatforms: ['macos'] }]);
});

test('a missing, malformed, absent or duplicated Shape falls back to ## Authority and says so', async () => {
  const cases: [ReturnType<typeof shape>[], string][] = [
    [[shape('no line')], 'missing-line'],
    [[shape('Proposal rules: R3.1–R3.2')], 'malformed-line'],
    [[], 'no-shape'],
    [[shape('Proposal rules: R3.1', 'someone-else')], 'no-shape'],
    [[shape('Proposal rules: R3.1'), shape('Proposal rules: R3.2')], 'multiple-shapes'],
  ];
  for (const [comments, state] of cases) {
    const gh = new FakeGate();
    delivered(gh, '## Authority\nProposal §5 and R3.1\n## Next', comments);
    const p = await plan(gh, ref);
    equal(p.source?.state, state);
    deepEqual(p.source?.fallback, { ids: ['R3.1', 'R5.13', 'R5.14'], sections: [5] });
    deepEqual(p.selection, { all: false, rules: ['R3.1', 'R5.13', 'R5.14'] });
    match(p.summary, /fell back to the Issue's ## Authority/);
    if (state === 'malformed-line') {
      equal(p.source?.malformed, 'Proposal rules: R3.1–R3.2');
      match(p.summary, /malformed Shape line \| treated like a missing line: Proposal rules: R3\.1–R3\.2/);
    }
  }
});

test('an Issue not closed with delivered selects nothing', async () => {
  for (const issue of [
    { state: 'open' as const, labels: ['delivered'] },
    { state: 'closed' as const, labels: [] },
    { state: 'closed' as const, labels: ['delivered'], pull_request: true },
  ]) {
    const gh = new FakeGate();
    gh.addIssue(CORE, { title: 'x', body: '## Authority\nR3.1', comments: [shape('Proposal rules: R3.1')], ...issue });
    const p = await plan(gh, ref);
    equal(p.source?.state, 'not-delivered');
    deepEqual(p.selection, { all: false, rules: [] });
    equal(p.execute, false);
    match(p.decisions[0]?.decision ?? '', /not delivered/);
    deepEqual(
      gh.reads.filter((r) => r.includes('scope')),
      [],
    );
  }
});

test('an explicit selection files gaps only for selected rules; unknown ids are usage errors', async () => {
  const gh = new FakeGate();
  const p = await plan(gh, { mode: 'select', rules: ['R5.14'], sections: ['3'] });
  deepEqual(p.selection, { all: false, rules: ['R3.1', 'R3.2', 'R5.14'] });
  deepEqual(p.gaps, [{ id: 'R5.14', missing: ['macos'] }]);
  const bad = await makePlan(gh, map, scenarios, { mode: 'select', rules: ['R9.9'], sections: [] });
  deepEqual(bad, { usage: ['--rule R9.9: not in the coverage map'] });
});

test('--all files no gaps, lists every gap and still marks waiting rules', async () => {
  const gh = new FakeGate();
  gh.addIssue(CORE, { title: 'scope', labels: ['scope'], body: '## Authority\nR5.13' });
  const p = await plan(gh, { mode: 'all' });
  deepEqual(p.selection, { all: true });
  deepEqual(p.gaps, []);
  deepEqual(p.unselectedGaps, [{ id: 'R5.14', missingPlatforms: ['macos'] }]);
  deepEqual(p.waiting, [{ id: 'R5.13', issues: ['https://github.com/taco3064/nibfin-core/issues/1'] }]);
  equal(p.execute, true);
  equal(p.coverage.passed, false);
  equal(gh.writes.length, 0);
});
