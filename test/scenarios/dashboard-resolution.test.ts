import { deepEqual, doesNotMatch, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import {
  autoEligible,
  autoProblem,
  causeShown,
  chooseDialogProblems,
  controlsFromAriaSnapshot,
  decisionOption,
  decisionStopNotExercised,
  elementMissing,
  LAG_MS,
  latestPending,
  needsExpected,
  nextStepLines,
  nibfinPending,
  optionLabel,
  optionOfChoice,
  ownWordsComment,
  ownWordsIndex,
  PENDING_SKEW_MS,
  pendingCause,
  shownState,
  stateOfRecord,
} from '../../scenarios/dashboard/checks.ts';
import type { LabelEvent } from '../../scenarios/dashboard/checks.ts';
import { awaitRecord } from '../../scenarios/dashboard/resolution.ts';
import type { IssueRead } from '../../scenarios/dashboard/resolution.ts';
import { defineScenario } from '../../scenarios/dashboard/support.ts';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';
import { parseRecord, resolutionRecord } from '../../scenarios/lib/resolution.ts';
import type { RunContext } from '../../src/types.ts';

const T0 = Date.parse('2026-11-28T10:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
let nextId = 1;
const comment = (body: string, created: number, updated = created): Comment => {
  const id = nextId++;
  return {
    id,
    body,
    created_at: at(created),
    updated_at: at(updated),
    user: { login: 'nibfin-bot' },
    html_url: `https://github.com/o/exec/issues/1#issuecomment-${id}`,
  };
};
const labeled = (ms: number, name = 'pending'): LabelEvent => ({
  event: 'labeled',
  created_at: at(ms),
  label: { name },
});
const unlabeled = (ms: number, name = 'pending'): LabelEvent => ({
  event: 'unlabeled',
  created_at: at(ms),
  label: { name },
});

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
  equal(
    nibfinPending(labels, reAdded, [{ ...old, updated_at: at(10 * 60_000 - PENDING_SKEW_MS / 2) }]),
    true,
    'the same comment updated for the re-add',
  );
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
  match(
    autoProblem({ labels }, events, [pend, record], T0 + 30_000 + LAG_MS + 1) ?? '',
    /resolution record .* older than the read/,
  );
  equal(autoEligible({ labels }, events, [pend, record], T0 + 30_000 + LAG_MS - 1), true, 'record newer than LAG_MS');
  // R4.52: resume without a decision, the rerun stops again; the first stop's record is older than the new pending.
  const reAdded = [labeled(0), unlabeled(10 * 60_000), labeled(20 * 60_000)];
  const freshPending = { ...pend, updated_at: at(20 * 60_000 - 1000) };
  equal(
    autoEligible({ labels }, reAdded, [freshPending, comment(HANDLE, 60_000)], T0 + 40 * 60_000),
    true,
    'a record from before a re-added pending is ignored',
  );
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
  deepEqual(
    needsExpected(
      held,
      shown.filter((x) => x.eligible).map((x) => x.i),
    ),
    [d, p, r],
  );
  // A re-added pending whose only record is older, but which the Dashboard does not show as auto, stays counted.
  deepEqual(needsExpected(held, []).length, 4);
});

test('causeShown matches the first 20 characters loosely; nextStepLines reads the steps under the heading', () => {
  equal(
    causeShown(
      '需要你處理 The repository .nibfin.json is…',
      'The repository .nibfin.json is invalid, so Core refused the Job.',
    ),
    true,
  );
  equal(causeShown('等你選擇 · 半數如何進位是產品決策，交給 Owner', '半數如何進位是產品決策，交給 Owner。'), true);
  equal(causeShown('something else', 'The repository .nibfin.json is invalid'), false);
  equal(causeShown('anything', ''), false);
  deepEqual(nextStepLines(HANDLE), ['Fix `tools` in .nibfin.json to a list.', 'Run `gh nibfin resume`.']);
  deepEqual(
    nextStepLines('<!-- nibfin:repair -->\n## 後續建議\n- 修正 `.nibfin.json`\n- 執行 resume\n## 依據\n- run 1'),
    ['修正 `.nibfin.json`', '執行 resume'],
  );
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

// The 等你選擇 dialog (R9.54 as amended, R4.51): options, the recommended one preselected, and an own-words reply.
const failing = (ps: { ok: boolean; message: string }[]) => ps.filter((p) => !p.ok).map((p) => p.message);
const CHOOSE_TEXT = '產品決策 How halves round is an open product decision 1. Round half to even 2. Round half away from zero';
const OPTION_CHOICES = [
  { name: '1. Round half to even', checked: true },
  { name: '2. Round half away from zero', checked: false },
];

test('chooseDialogProblems passes the options, the recommended one preselected and a free-text field', () => {
  const r = parseRecord(comment(CHOOSE, 0));
  const ps = chooseDialogProblems(
    { text: CHOOSE_TEXT, choices: OPTION_CHOICES, textboxes: 1, controls: [] },
    r,
    7,
  );
  deepEqual(failing(ps), []);
  equal(ps.every((p) => p.rule === 'R9.54'), true);
});

test('chooseDialogProblems fails R9.54 without an own-words control, naming the controls and quoting the dialog', () => {
  const r = parseRecord(comment(CHOOSE, 0));
  const controls = ['radio "1. Round half to even"', 'radio "2. Round half away from zero"', 'button "送出"'];
  const bad = failing(chooseDialogProblems({ text: CHOOSE_TEXT, choices: OPTION_CHOICES, textboxes: 0, controls }, r, 7));
  equal(bad.length, 1);
  match(bad[0] ?? '', /dialog of #7 offers no way to reply in your own words \(R4\.51\)/);
  match(bad[0] ?? '', /controls: radio "1\. Round half to even", radio "2\. Round half away from zero", button "送出"/);
  match(bad[0] ?? '', /dialog: "產品決策 How halves round/);
});

test('an own-words choice is not a missing or extra option and counts as the own-words control', () => {
  const r = parseRecord(comment(CHOOSE, 0));
  for (const name of ['用自己的話回覆', 'Reply in your own words']) {
    const choices = [...OPTION_CHOICES, { name, checked: false }];
    equal(ownWordsIndex(choices, r), 2, name);
    for (const textboxes of [0, 1])
      deepEqual(failing(chooseDialogProblems({ text: CHOOSE_TEXT, choices, textboxes, controls: [] }, r, 7)), [], name);
  }
  const other = [...OPTION_CHOICES, { name: 'Round half down', checked: false }];
  equal(ownWordsIndex(other, r), undefined);
  const bad = failing(chooseDialogProblems({ text: CHOOSE_TEXT, choices: other, textboxes: 1, controls: [] }, r, 7));
  deepEqual(bad, [`the 「排除」 dialog of #7 lists 3 choices, not the record's 2; dialog: "${CHOOSE_TEXT}"`]);
  const preOwn = [
    { name: '1. Round half to even', checked: false },
    { name: '2. Round half away from zero', checked: false },
    { name: '用自己的話回覆', checked: true },
  ];
  deepEqual(failing(chooseDialogProblems({ text: CHOOSE_TEXT, choices: preOwn, textboxes: 1, controls: [] }, r, 7)), [
    'the 「排除」 dialog of #7 preselects choice 3 (no option matched), not the recommended option 1',
  ]);
});

test('ownWordsComment holds the reply verbatim, allowing only Nibfin markers, CRLF and outer whitespace', () => {
  const reply = 'nibfin-e2e rab12cd: decided in my own words, round exact halves to the nearest even integer.';
  equal(ownWordsComment(reply, reply), true);
  equal(ownWordsComment(`<!-- nibfin:decision -->\n${reply}`, reply), true);
  equal(ownWordsComment(`\r\n  ${reply}\r\n`, reply), true);
  const two = 'first line\nsecond line';
  equal(ownWordsComment('first line\r\nsecond line', two), true);
  equal(ownWordsComment('<!-- nibfin:decision option=1 -->\nDecided: option 1', reply), false);
  equal(ownWordsComment('something else entirely', reply), false);
  equal(ownWordsComment(`${reply} Thanks!`, reply), false);
});

test('controlsFromAriaSnapshot lists each control by role and name, unnamed ones too', () => {
  const snapshot = [
    '- dialog "排除":',
    '  - heading "等你選擇" [level=2]',
    '  - text: How halves round',
    '  - radiogroup:',
    '    - radio "1. Round half to even" [checked]',
    '    - radio "2. Round half away from zero"',
    '  - textbox',
    '  - link "run log":',
    '    - /url: https://github.com/o/exec/actions/runs/1',
    '  - button "送出"',
  ].join('\n');
  deepEqual(controlsFromAriaSnapshot(snapshot), [
    'radio "1. Round half to even"',
    'radio "2. Round half away from zero"',
    'textbox (unnamed)',
    'button "送出"',
  ]);
});

test('defineScenario returns the gate outcome without running, and runs when the gate is open', async () => {
  let ran = 0;
  const ctx = { log: () => {} } as unknown as RunContext;
  const s = (gate: { status: 'waiting'; reason: string } | undefined) =>
    defineScenario({ id: 'x', rules: ['R9.52'], gate: async () => gate, run: async () => (ran++, 'ok') });
  deepEqual(await s({ status: 'waiting', reason: 'not delivered' }).run(ctx), {
    status: 'waiting',
    reason: 'not delivered',
  });
  equal(ran, 0);
  deepEqual(await s(undefined).run(ctx), { status: 'passed', reason: 'ok' });
  equal(ran, 1);
});

// The record wait (R9.52, R4.49, R3.42): the unfinished record and its in-place updates are waited past.
const UNFINISHED = "<!-- nibfin:repair -->\nCategory: being classified - Reason: Nibfin's repair agent is looking at this stop";
const recordComment = (body: string, updated: number): Comment => ({
  id: 42,
  body,
  created_at: at(60_000),
  updated_at: at(updated),
  user: { login: 'nibfin-bot' },
  html_url: 'https://github.com/o/exec/issues/9#issuecomment-42',
});
const issueState = (comments: Comment[], labels = ['scope', 'pending']): IssueRead => ({
  state: 'open',
  labels,
  comments,
  record: resolutionRecord(comments, T0),
});
/** A fake clock for waitFor, and a read that returns each state in turn and then the last one. */
function scripted(states: IssueRead[]) {
  let t = T0;
  let i = 0;
  const reads = { count: 0 };
  const read = async () => {
    reads.count++;
    return states[Math.min(i++, states.length - 1)] as IssueRead;
  };
  const options = {
    what: 'a finished resolution record on #9',
    deadlineMs: 15 * 60_000,
    intervalMs: 20_000,
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
  };
  return { read, options, reads };
}

test('awaitRecord waits past the unfinished record and accepts the same comment once updated with a class', async () => {
  const s = scripted([
    issueState([]),
    issueState([recordComment(UNFINISHED, 60_000)]),
    issueState([recordComment(UNFINISHED, 80_000)]),
    issueState([recordComment(HANDLE, 120_000)]),
  ]);
  const got = await awaitRecord(s.read, 9, T0, s.options);
  equal(s.reads.count, 4);
  equal(got.record.id, 42);
  equal(got.record.class, 'operations-or-manual');
  equal(got.comments.length, 1);
});

test('awaitRecord names the unfinished record when it never names a class before the deadline', async () => {
  const s = scripted([issueState([recordComment(UNFINISHED, 60_000)])]);
  await rejects(awaitRecord(s.read, 9, T0, s.options), (e: Error) => {
    match(e.message, /latest resolution record https:\/\/github\.com\/o\/exec\/issues\/9#issuecomment-42 on #9/);
    match(e.message, /never named one of the six R4\.41 classes within 15 min/);
    match(e.message, /being classified/);
    return true;
  });
});

test('awaitRecord still ends early when pending goes, naming the unfinished record', async () => {
  const s = scripted([issueState([recordComment(UNFINISHED, 60_000)], ['scope'])]);
  await rejects(
    awaitRecord(s.read, 9, T0, s.options),
    /#9 lost pending before its resolution record https:\S+issuecomment-42 named a class/,
  );
  const none = scripted([{ ...issueState([]), state: 'closed' }]);
  await rejects(awaitRecord(none.read, 9, T0, none.options), /#9 closed before a resolution record appeared/);
});

test('a product-decision fixture whose finished record has no options names its pending cause, class and record', () => {
  const pend = comment('<!-- nibfin:pending -->\nNibfin stopped: STAGE_HOST_MEMORY_LOW, the host is low on memory.', 0);
  const older = comment('<!-- nibfin:pending -->\nNibfin stopped: STAGE_BLOCKED.', -60_000);
  const r = parseRecord(comment(HANDLE, 30_000));
  deepEqual(pendingCause([pend, older]), { url: pend.html_url, codes: ['STAGE_HOST_MEMORY_LOW'] });
  const why = decisionStopNotExercised({ name: 'product-decision', n: 526 }, r, [older, pend]);
  match(why, /product-decision fixture #526 stopped with pending cause STAGE_HOST_MEMORY_LOW/);
  match(why, new RegExp(pend.html_url.replace(/[.#/]/g, '\\$&')));
  match(why, /classed 維運或人為操作 with no options/);
  match(why, new RegExp(`finished record ${r.url.replace(/[.#/]/g, '\\$&')}`));
  doesNotMatch(why, /STAGE_BLOCKED/);
  match(decisionStopNotExercised({ name: 'x', n: 1 }, r, []), /stopped with no pending comment/);
  match(
    decisionStopNotExercised({ name: 'x', n: 1 }, r, [comment(PENDING(), 0)]),
    /no cause code in its latest pending comment/,
  );
});

test('elementMissing says the element was not found and names the view and its update marker', () => {
  const m = elementMissing(
    { name: 'product-decision', n: 526, title: 'Add roundHalf' },
    'repo view, update marker manual, refreshed 4 time(s) by its Refresh control, last at 2026-11-28T10:05:00.000Z',
  );
  match(m, /#526's element "Add roundHalf" was not found in the repo view, update marker manual, refreshed 4 time/);
  doesNotMatch(m, /""/);
});
