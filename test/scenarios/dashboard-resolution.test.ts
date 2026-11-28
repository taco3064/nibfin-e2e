import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import {
  autoEligible,
  autoProblem,
  causeShown,
  decisionOption,
  LAG_MS,
  latestPending,
  needsExpected,
  nextStepLines,
  nibfinPending,
  optionLabel,
  optionOfChoice,
  PENDING_SKEW_MS,
  shownState,
  stateOfRecord,
} from '../../scenarios/dashboard/checks.ts';
import type { LabelEvent } from '../../scenarios/dashboard/checks.ts';
import { defineScenario } from '../../scenarios/dashboard/support.ts';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';
import { parseRecord } from '../../scenarios/lib/resolution.ts';
import type { RunContext } from '../../src/types.ts';

const T0 = Date.parse('2026-11-28T10:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
let nextId = 1;
const comment = (body: string, created: number, updated = created): Comment => {
  const id = nextId++;
  return { id, body, created_at: at(created), updated_at: at(updated), user: { login: 'nibfin-bot' }, html_url: `https://github.com/o/exec/issues/1#issuecomment-${id}` };
};
const labeled = (ms: number, name = 'pending'): LabelEvent => ({ event: 'labeled', created_at: at(ms), label: { name } });
const unlabeled = (ms: number, name = 'pending'): LabelEvent => ({ event: 'unlabeled', created_at: at(ms), label: { name } });

const PENDING = (n = 1) => `<!-- nibfin:pending -->\nNibfin stopped (${n}).`;
const CHOOSE = [
  '<!-- nibfin:repair -->',
  '分類：產品決策',
  '原因：How halves round is an open product decision left to the Owner.',
  '選項：',
  '1. Round half to even (建議)',
  '2. Round half away from zero',
].join('\n');
const HANDLE = [
  '<!-- nibfin:repair -->',
  '分類：維運或人為操作',
  '原因：The repository .nibfin.json is invalid, so Core refused the Job.',
  '後續建議：',
  '1. Fix `tools` in .nibfin.json to a list.',
  '2. Run `gh nibfin resume`.',
].join('\n');

test('stateOfRecord: no record is 自動排除中, options 等你選擇, next steps 需要你處理, neither no state', () => {
  equal(stateOfRecord(undefined), 'auto');
  equal(stateOfRecord(parseRecord(comment(CHOOSE, 0))), 'choose');
  equal(stateOfRecord(parseRecord(comment(HANDLE, 0))), 'handle');
  equal(stateOfRecord(parseRecord(comment('<!-- nibfin:repair -->\n分類：產品決策\n原因：x', 0))), undefined);
});

test('shownState names one state in Chinese or English, and none when zero or two are named', () => {
  equal(shownState('Add roundHalf · pending · 自動排除中 · checking the failure'), 'auto');
  equal(shownState('pending — Repairing automatically'), 'auto');
  equal(shownState('pending 等你選擇 Repair'), 'choose');
  equal(shownState('pending · waiting for your decision'), 'choose');
  equal(shownState('需要你處理：the config is invalid'), 'handle');
  equal(shownState('pending · Action needed · Repair'), 'handle');
  equal(shownState('Add roundHalf · pending · Repair · Pause'), undefined);
  equal(shownState('自動排除中 等你選擇'), undefined);
});

test('latestPending is the most recent labeled pending event, and undefined without the label', () => {
  const events = [labeled(0), unlabeled(60_000), labeled(120_000), labeled(10_000, 'scope')];
  equal(latestPending(['scope', 'pending'], events), T0 + 120_000);
  equal(latestPending(['scope'], events), undefined);
  equal(latestPending(['pending'], []), undefined);
});

test('nibfinPending: a pending comment written for the latest pending, with the skew for Nibfin writing it first', () => {
  const labels = ['scope', 'pending'];
  equal(nibfinPending(labels, [labeled(0)], []), false, 'fixture D: a harness pending without a pending comment');
  equal(nibfinPending(labels, [labeled(0)], [comment(PENDING(), -30_000)]), true, 'written 30 s before the label');
  const old = comment(PENDING(), 0);
  const reAdded = [labeled(0), unlabeled(5 * 60_000), labeled(10 * 60_000)];
  equal(nibfinPending(labels, reAdded, [old]), false, 'a pending comment of an earlier stop, not updated');
  equal(nibfinPending(labels, reAdded, [{ ...old, updated_at: at(10 * 60_000 - PENDING_SKEW_MS / 2) }]), true, 'the same comment updated for the re-add');
  equal(nibfinPending(['scope'], [labeled(0)], [comment(PENDING(), 0)]), false, 'no pending label');
});

test('autoEligible: no pause, a Nibfin pending, and no record older than the Dashboard lag after that pending', () => {
  const labels = ['scope', 'pending'];
  const events = [labeled(0)];
  const pend = comment(PENDING(), -1000);
  equal(autoEligible({ labels: [...labels, 'pause'] }, events, [pend], T0 + 60_000), false);
  match(autoProblem({ labels: [...labels, 'pause'] }, events, [pend], T0 + 60_000) ?? '', /pause/);
  equal(autoEligible({ labels }, events, [pend], T0 + 60_000), true, 'no record yet');
  const record = comment(CHOOSE, 30_000);
  equal(autoEligible({ labels }, events, [pend, record], T0 + 30_000 + LAG_MS + 1), false, 'record older than LAG_MS');
  match(autoProblem({ labels }, events, [pend, record], T0 + 30_000 + LAG_MS + 1) ?? '', /resolution record .* older than the read/);
  equal(autoEligible({ labels }, events, [pend, record], T0 + 30_000 + LAG_MS - 1), true, 'record newer than LAG_MS');
  // R4.52: resume without a decision, the rerun stops again; the first stop's record is older than the new pending.
  const reAdded = [labeled(0), unlabeled(10 * 60_000), labeled(20 * 60_000)];
  const freshPending = { ...pend, updated_at: at(20 * 60_000 - 1000) };
  equal(autoEligible({ labels }, reAdded, [freshPending, comment(HANDLE, 60_000)], T0 + 40 * 60_000), true, 'a record from before a re-added pending is ignored');
  equal(autoEligible({ labels }, events, [], T0 + 60_000), false, 'fixture D');
  match(autoProblem({ labels }, events, [], T0 + 60_000) ?? '', /no Nibfin pending comment/);
});

test('needsExpected leaves out only Issues shown as 自動排除中 and eligible', () => {
  const issue = (n: number) => ({ html_url: `https://github.com/o/exec/issues/${n}`, n });
  const [a, d, p, r] = [issue(1), issue(2), issue(3), issue(4)];
  const held = [a, d, p, r];
  deepEqual(needsExpected(held, []), held, 'no 自動排除中 Issue: every held Issue counts');
  deepEqual(needsExpected(held, [a]), [d, p, r], 'an eligible 自動排除中 Issue is not counted');
  // D shown as auto is not eligible, so the caller passes only eligible ones; it stays counted.
  const shown = [
    { i: a, eligible: autoEligible({ labels: ['pending'] }, [labeled(0)], [comment(PENDING(), 0)], T0 + 1000) },
    { i: d, eligible: autoEligible({ labels: ['pending'] }, [labeled(0)], [], T0 + 1000) },
  ];
  deepEqual(needsExpected(held, shown.filter((x) => x.eligible).map((x) => x.i)), [d, p, r]);
  // A re-added pending whose only record is older, but which the Dashboard does not show as auto, stays counted.
  deepEqual(needsExpected(held, []).length, 4);
});

test('causeShown matches the first 20 characters loosely; nextStepLines reads the steps under the heading', () => {
  equal(causeShown('需要你處理 The repository .nibfin.json is…', 'The repository .nibfin.json is invalid, so Core refused the Job.'), true);
  equal(causeShown('等你選擇 · 半數如何進位是產品決策，交給 Owner', '半數如何進位是產品決策，交給 Owner。'), true);
  equal(causeShown('something else', 'The repository .nibfin.json is invalid'), false);
  equal(causeShown('anything', ''), false);
  deepEqual(nextStepLines(HANDLE), ['Fix `tools` in .nibfin.json to a list.', 'Run `gh nibfin resume`.']);
  deepEqual(nextStepLines('<!-- nibfin:repair -->\n## 後續建議\n- 修正 `.nibfin.json`\n- 執行 resume\n## 依據\n- run 1'), ['修正 `.nibfin.json`', '執行 resume']);
  deepEqual(nextStepLines('Next steps: fix the file'), ['fix the file']);
  deepEqual(nextStepLines(CHOOSE), []);
});

test('option helpers: labels without the recommendation, choices by number or text, the decision comment', () => {
  const r = parseRecord(comment(CHOOSE, 0));
  equal(r.recommended, 1);
  equal(optionLabel('Round half to even (建議)'), 'Round half to even');
  equal(optionLabel('Round half to even — recommended'), 'Round half to even');
  equal(optionOfChoice('2. Round half away from zero', r.options), 2);
  equal(optionOfChoice('Round half to even (recommended)', r.options), 1);
  equal(optionOfChoice('something else', r.options), undefined);
  equal(decisionOption('<!-- nibfin:decision option=2 -->\nDecided: option 2'), 2);
  equal(decisionOption('1'), 1);
  equal(decisionOption('<!-- nibfin:decision -->\nI choose the first'), undefined);
});

test('defineScenario returns the gate outcome without running, and runs when the gate is open', async () => {
  let ran = 0;
  const ctx = { log: () => {} } as unknown as RunContext;
  const s = (gate: { status: 'waiting'; reason: string } | undefined) =>
    defineScenario({ id: 'x', rules: ['R9.52'], gate: async () => gate, run: async () => (ran++, 'ok') });
  deepEqual(await s({ status: 'waiting', reason: 'not delivered' }).run(ctx), { status: 'waiting', reason: 'not delivered' });
  equal(ran, 0);
  deepEqual(await s(undefined).run(ctx), { status: 'passed', reason: 'ok' });
  equal(ran, 1);
});
