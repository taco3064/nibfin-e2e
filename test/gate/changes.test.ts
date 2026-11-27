import { deepEqual, equal, match } from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { affectedScenarios, classifyPath, indexScenarios } from '../../src/gate/changes.ts';
import type { SourceFile } from '../../src/gate/changes.ts';
import { readScenarioSources } from '../../src/gate/cli.ts';
import { parseIssueRef } from '../../src/gate/impact.ts';
import { makePlan } from '../../src/gate/plan.ts';
import type { Plan } from '../../src/gate/plan.ts';
import { scenarios as registered } from '../../src/registry.ts';
import { map, scenarios } from '../fixtures.ts';
import { FakeGate } from './fake.ts';
import type { FakePull, FakeIssue } from './fake.ts';

const E2E = 'taco3064/nibfin-e2e';
const CORE = 'taco3064/nibfin-core';

// `a` is defined literally and uses a shared helper; `b` comes from a factory; the index defines none.
const sources: SourceFile[] = [
  { path: 'scenarios/a.ts', text: "import { help } from './lib/help.ts';\nexport const a = {\n  id: 'a',\n  rules: [],\n};\n" },
  { path: 'scenarios/b.ts', text: "import type { Scenario } from '../src/types.ts';\nexport const b = make(\n  'b',\n  ['R3.2'],\n);\n" },
  { path: 'scenarios/lib/help.ts', text: "export const help = (ctx) => ctx.log('helping');\n" },
  { path: 'scenarios/index.ts', text: "import { a } from './a.ts';\nimport {\n  b,\n} from './b.ts';\nexport const all = [a, b];\n" },
];

const shape = (text: string) => ({ body: `<!-- nibfin:shape -->\n## Goal\n${text}\n`, user: 'taco3064', updated_at: '2026-11-26T00:00:00Z', html_url: `https://github.com/${E2E}/issues/1#shape` });
const file = (filename: string, previous_filename?: string) => ({ filename, status: previous_filename ? 'renamed' : 'modified', ...(previous_filename ? { previous_filename } : {}) });

function e2eIssue(gh: FakeGate, line: string, pulls: (Partial<FakePull> & { files: FakePull['files'] })[], repo = E2E, comments: FakeIssue['comments'] = [shape(line)]) {
  const issue = gh.addIssue(repo, { title: 'scenario fix', state: 'closed', labels: ['delivered'], body: '## Authority\nR5.13', comments });
  pulls.forEach((p, i) => gh.addPull(repo, { number: 100 + i, head: `nibfin/issue-${issue.number}`, ...p }));
  return issue;
}

async function plan(gh: FakeGate, repo = E2E, src: () => SourceFile[] = () => sources): Promise<Plan> {
  const out = await makePlan(gh, map, scenarios, { mode: 'delivered', ref: { repo, number: 1 } }, src);
  if ('usage' in out) throw new Error(out.usage.join('; '));
  return out.plan;
}

test('paths are classified as scenario, harness or nothing', () => {
  deepEqual(
    ['scenarios/a.ts', 'src/host/sandbox.ts', 'src/run.ts', 'sandbox-template/package.json', 'src/gate/plan.ts', 'test/run.test.ts', 'README.md', 'coverage-map.json', 'relay/src/index.ts', 'package.json', '.github/workflows/e2e.yml'].map(classifyPath),
    ['scenario', 'harness', 'harness', 'harness', 'other', 'other', 'other', 'other', 'other', 'other', 'other'],
  );
});

test('a changed file affects the scenarios it defines and those of every file importing it', () => {
  const index = indexScenarios(sources, ['a', 'b']);
  deepEqual(affectedScenarios(index, 'scenarios/a.ts'), ['a']);
  deepEqual(affectedScenarios(index, 'scenarios/b.ts'), ['b']);
  deepEqual(affectedScenarios(index, 'scenarios/lib/help.ts'), ['a']);
  deepEqual(affectedScenarios(index, 'scenarios/index.ts'), []);
  deepEqual(affectedScenarios(index, 'scenarios/gone.ts'), []);
});

test('an e2e Issue whose merged PR changes one scenario file selects that scenario\'s rules', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, 'Proposal rules: none', [{ files: [file('scenarios/a.ts'), file('test/scenarios/a.test.ts')] }]);
  const p = await plan(gh);
  deepEqual(p.source?.pulls, [`https://github.com/${E2E}/pull/100`]);
  deepEqual(p.selection, { all: false, rules: ['R3.1', 'R3.2'] });
  equal(p.execute, true);
  match(p.summary, /\| scenarios\/a\.ts \| selected from the changed scenario file \| scenarios: a; rules: R3\.1, R3\.2 \|/);
  match(p.summary, /nothing selected from these files \| only docs, tests, gate code or configuration: test\/scenarios\/a\.test\.ts/);
});

test('a shared helper selects its importers\' scenarios; Shape-line rules are combined with them', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, 'Proposal rules: R5.13', [{ files: [file('scenarios/lib/help.ts')] }]);
  const p = await plan(gh);
  equal(p.source?.state, 'line');
  deepEqual(p.selection, { all: false, rules: ['R5.13', 'R3.1', 'R3.2'] });
});

test('a renamed scenario file counts under both names', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, 'Proposal rules: none', [{ files: [file('scenarios/b.ts', 'scenarios/old-b.ts')] }]);
  const p = await plan(gh);
  deepEqual(p.selection, { all: false, rules: ['R3.2', 'R5.13'] });
  match(p.summary, /\| scenarios\/old-b\.ts \| no scenario selected \|/);
});

test('an e2e Issue that changes harness code or the sandbox template selects every rule', async () => {
  for (const changed of ['src/host/sandbox.ts', 'sandbox-template/src/index.ts']) {
    const gh = new FakeGate();
    e2eIssue(gh, 'Proposal rules: none', [{ files: [file(changed)] }]);
    const p = await plan(gh);
    // Every map rule goes through the delivered path: R0.1 is excluded, R5.14 is a gap.
    deepEqual(p.selection, { all: false, rules: ['R3.1', 'R3.2', 'R5.13', 'R5.14'] });
    deepEqual(p.excluded, [{ id: 'R0.1', reason: '文件定位' }]);
    deepEqual(p.gaps, [{ id: 'R5.14', missing: ['macos'] }]);
    equal(p.mode, 'delivered');
    match(p.summary, new RegExp(`selected every rule \\| harness, provisioning or sandbox template changed: ${changed.replace(/\./g, '\\.')}`));
  }
});

test('a PR listing 3000 files may be truncated and selects every rule', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, 'Proposal rules: none', [{ files: Array.from({ length: 3000 }, (_, i) => file(`docs/${i}.md`)) }]);
  const p = await plan(gh);
  deepEqual(p.selection, { all: false, rules: ['R3.1', 'R3.2', 'R5.13', 'R5.14'] });
  match(p.summary, /lists 3000 files, so the list may be truncated/);
});

test('an e2e Issue that changes only docs, tests or gate code selects nothing and says why', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, 'Proposal rules: none', [{ files: [file('README.md'), file('test/gate/plan.test.ts'), file('src/gate/plan.ts')] }]);
  let read = false;
  const p = await plan(gh, E2E, () => ((read = true), sources));
  deepEqual(p.selection, { all: false, rules: [] });
  equal(p.execute, false);
  equal(read, false);
  match(p.summary, /only docs, tests, gate code or configuration: README\.md, test\/gate\/plan\.test\.ts, src\/gate\/plan\.ts/);
  match(p.summary, /no change selected \| the merged PRs changed no harness/);
});

test('without a merged PR only the Shape line or Authority selects', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, 'Proposal rules: R3.1', [
    { merged_at: null, files: [file('src/run.ts')] },
    { base: 'other', files: [file('src/run.ts')] },
  ]);
  const p = await plan(gh);
  deepEqual(p.source?.pulls, []);
  deepEqual(p.selection, { all: false, rules: ['R3.1'] });
  match(p.summary, /no merged PR on nibfin\/issue-1: only the Shape line or Authority selects/);
  equal(gh.reads.some((r) => r.includes('/files')), false);
});

test('CD fix branches are probed in order until one has no PR', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, 'Proposal rules: none', [{ files: [file('docs/x.md')] }]);
  gh.addPull(E2E, { number: 200, head: 'nibfin/issue-1-cd-1', files: [file('scenarios/b.ts')] });
  gh.addPull(E2E, { number: 201, head: 'nibfin/issue-1-cd-3', files: [file('src/run.ts')] });
  const p = await plan(gh);
  deepEqual(p.source?.pulls, [`https://github.com/${E2E}/pull/100`, `https://github.com/${E2E}/pull/200`]);
  deepEqual(p.selection, { all: false, rules: ['R3.2', 'R5.13'] });
  deepEqual(
    gh.reads.filter((r) => r.includes('head=')).map((r) => new URL('https://x' + r).searchParams.get('head')),
    ['taco3064:nibfin/issue-1', 'taco3064:nibfin/issue-1-cd-1', 'taco3064:nibfin/issue-1-cd-2'],
  );
});

test('the Authority fallback still applies to an e2e Issue', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, '', [{ files: [file('scenarios/a.ts')] }], E2E, []);
  const p = await plan(gh);
  equal(p.source?.state, 'no-shape');
  deepEqual(p.selection, { all: false, rules: ['R5.13', 'R3.1', 'R3.2'] });
});

test('an e2e Issue not closed with delivered reads no PR', async () => {
  const gh = new FakeGate();
  const issue = e2eIssue(gh, 'Proposal rules: none', [{ files: [file('src/run.ts')] }]);
  issue.state = 'open';
  const p = await plan(gh);
  equal(p.source?.state, 'not-delivered');
  equal(p.execute, false);
  equal(gh.reads.some((r) => r.includes('/pulls')), false);
});

test('core Issues read no PR files; e2e scope Issues mark no rule waiting', async () => {
  const gh = new FakeGate();
  e2eIssue(gh, 'Proposal rules: R3.1', [{ files: [file('src/run.ts')] }], CORE);
  gh.addIssue(E2E, { title: 'scope', labels: ['scope'], body: '## Authority\nR3.1' });
  const p = await plan(gh, CORE);
  deepEqual(p.source?.pulls, undefined);
  deepEqual(p.selection, { all: false, rules: ['R3.1'] });
  deepEqual(p.waiting, []);
  equal(gh.reads.some((r) => r.includes('/pulls')), false);
  equal(gh.reads.some((r) => r.startsWith(`/repos/${E2E}/`)), false);
});

test('--delivered accepts the three repositories and rejects any other', () => {
  deepEqual(parseIssueRef('taco3064/nibfin-e2e#336'), { repo: E2E, number: 336 });
  deepEqual(parseIssueRef('taco3064/nibfin-core#1'), { repo: CORE, number: 1 });
  deepEqual(parseIssueRef('taco3064/gh-nibfin#2'), { repo: 'taco3064/gh-nibfin', number: 2 });
  deepEqual(parseIssueRef('taco3064/other#1'), { error: '--delivered taco3064/other#1: the repository must be one of taco3064/nibfin-core, taco3064/gh-nibfin, taco3064/nibfin-e2e' });
});

test('every registry scenario id is defined in exactly one file under scenarios/', () => {
  const real = readScenarioSources(fileURLToPath(new URL('../..', import.meta.url)));
  const index = indexScenarios(real, registered.map((s) => s.id));
  const files = new Map<string, string[]>();
  for (const [path, ids] of index.defines) for (const id of ids) files.set(id, [...(files.get(id) ?? []), path]);
  const wrong = registered.map((s) => [s.id, files.get(s.id) ?? []] as const).filter(([, paths]) => paths.length !== 1);
  deepEqual(wrong, []);
  // A shared helper reaches the scenarios that use it.
  equal(affectedScenarios(index, 'scenarios/lifecycle/kit.ts').includes('delivery-lifecycle'), true);
});
