// The pure checks behind the amended R4.51 scenarios: picking a later option of a
// different rule for the second write collaborator, picking and writing a decision in the
// person's own words, and judging whether a part Shape cannot apply was named openly.
import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';
import {
  ROUNDING_RULES,
  bareNumberIn,
  chooseOption,
  chooseTwoOptions,
  chooseWordsRule,
  newlyNamed,
  optionRule,
  qualifying,
  unappliedNamed,
  wordsDecision,
} from '../../scenarios/lifecycle/resolution-decision.ts';
import type { RuleName } from '../../scenarios/lifecycle/resolution-decision.ts';
import { parseRecord } from '../../scenarios/lib/resolution.ts';

const zh = (...opts: string[]) =>
  parseRecord({
    id: 1,
    body: ['<!-- nibfin:repair -->', '分類：產品決策', '選項：', ...opts.map((o, i) => `${i + 1}. ${o}`)].join('\n'),
    created_at: '2026-11-27T00:00:00Z',
    updated_at: '2026-11-27T00:00:00Z',
    user: null,
    html_url: 'u',
  } as Comment);

const EVERY_TERM =
  "half to even, round half even, even, banker's, 偶數, 五成雙, 銀行家, away from zero, 遠離零, 遠離0, half up, toward positive infinity, 正無窮, half down, toward zero, 向零";

test('chooseTwoOptions picks two distinct rules with a non-recommended winner', () => {
  const r = zh('五成雙（建議）：2.5→2', '遠離零：2.5→3', '正無窮：-2.5→-2');
  const two = chooseTwoOptions(r, 'old');
  equal(two?.winner.option.n, 2);
  equal(two?.winner.rule, 'half-away');
  equal(two?.overridden.option.n, 1);
  equal(two?.overridden.rule, 'half-even');
  equal(two?.winner.option.recommended, false);
});

test('chooseTwoOptions takes another non-recommended option when the recommended one shares the winner rule', () => {
  const r = zh('遠離零（建議）：2.5→3', '遠離零，負數也一樣', '向零：2.5→2');
  const two = chooseTwoOptions(r, 'old');
  equal(two?.winner.rule, 'half-away');
  equal(two?.winner.option.n, 2);
  equal(two?.overridden.rule, 'half-down');
});

test('chooseTwoOptions is undefined with one qualifying rule, and the fallback is chooseOption', () => {
  const one = zh('五成雙（建議）：2.5→2', '四捨五入：2.5→3');
  equal(chooseTwoOptions(one, 'old'), undefined);
  deepEqual(chooseOption(one, 'old'), { option: one.options[0], rule: 'half-even' });
  const same = zh('遠離零（建議）', '遠離零，負數也一樣');
  equal(chooseTwoOptions(same, 'old'), undefined);
  equal(chooseOption(same, 'old')?.option.n, 2);
  const stale = zh('五成雙（建議）', '遠離零');
  equal(chooseTwoOptions(stale, 'away from zero 遠離零 遠離0'), undefined);
  deepEqual(
    qualifying(stale, 'away from zero 遠離零 遠離0').map((x) => x.rule),
    ['half-even'],
  );
});

test('chooseWordsRule prefers a rule no option names, then one no option resolves to, else any new rule', () => {
  deepEqual(chooseWordsRule(zh('五成雙（建議）：2.5→2', '遠離零：2.5→3'), 'old'), { rule: 'half-up', unnamed: true });
  deepEqual(chooseWordsRule(zh('五成雙（建議）：2.5→2', '遠離零：2.5→3', '正無窮'), 'old'), {
    rule: 'half-down',
    unnamed: true,
  });
  const mentioned = zh('五成雙（建議）：2.5→2，不同於遠離零、正無窮與向零', '遠離零：2.5→3');
  deepEqual(chooseWordsRule(mentioned, 'old'), { rule: 'half-up', unnamed: false });
  const all = zh('五成雙（建議）', '遠離零', '正無窮', '向零');
  deepEqual(chooseWordsRule(all, 'old'), { rule: 'half-even', unnamed: false });
  equal(chooseWordsRule(all, EVERY_TERM), undefined);
});

test('the own-words decision names exactly its rule and carries no bare option number', () => {
  const label = 'e2e-unapplied-r0a1b2c';
  for (const { id } of ROUNDING_RULES) {
    const text = wordsDecision(id, label);
    equal(optionRule(text), id, text);
    equal(bareNumberIn(text, [1, 2, 3, 4]), false, text);
    deepEqual(newlyNamed('', text), [id], text);
    match(text, new RegExp(label));
  }
  const rules: RuleName[] = ROUNDING_RULES.map((r) => r.id);
  equal(new Set(rules.map((id) => wordsDecision(id, label))).size, rules.length);
});

test('bareNumberIn finds a bare number or a standalone option number only', () => {
  equal(bareNumberIn('2', [1, 2]), true);
  equal(bareNumberIn(' 7 ', [1, 2]), true);
  equal(bareNumberIn('I choose option 2.', [1, 2]), true);
  equal(bareNumberIn('I choose option 3.', [1, 2]), false);
  equal(bareNumberIn('label e2e-unapplied-r123456', [1, 2, 3]), false);
});

const REMOVED = Date.parse('2026-11-28T10:00:00Z');
const LABEL = 'e2e-unapplied-rabc123';
const note = (id: number, body: string, at: string, updated = at): Comment => ({
  id,
  body,
  created_at: at,
  updated_at: updated,
  user: { login: 'nibfin-bot' },
  html_url: `https://github.com/o/exec/issues/1#issuecomment-${id}`,
});
const decision = note(1, `Round exact halves toward zero.\n\nAlso add the label \`${LABEL}\`.`, '2026-11-28T09:59:00Z');

test('unappliedNamed passes when the label is on the Issue', () => {
  const v = unappliedNamed({
    labels: ['shaped', LABEL],
    comments: [decision],
    label: LABEL,
    decisionId: 1,
    removedAt: REMOVED,
  });
  equal(v.ok, true);
  match(v.where ?? '', /carries/);
});

test('unappliedNamed passes when a comment written after the removal names the label', () => {
  const later = note(
    2,
    `Not applied: adding the label ${LABEL.toUpperCase()} is outside Shape.`,
    '2026-11-28T10:05:00Z',
  );
  const v = unappliedNamed({
    labels: ['shaped'],
    comments: [decision, later],
    label: LABEL,
    decisionId: 1,
    removedAt: REMOVED,
  });
  equal(v.ok, true);
  match(v.where ?? '', /issuecomment-2 names/);
});

test('unappliedNamed fails when neither holds and lists the comments it read', () => {
  const other = note(3, 'Shaped the Issue.', '2026-11-28T10:05:00Z');
  const v = unappliedNamed({
    labels: ['shaped'],
    comments: [decision, other],
    label: LABEL,
    decisionId: 1,
    removedAt: REMOVED,
  });
  equal(v.ok, false);
  deepEqual(v.read, ['https://github.com/o/exec/issues/1#issuecomment-3 by nibfin-bot']);
});

test('unappliedNamed ignores a comment from before the removal and the decision itself', () => {
  const early = note(4, `I will add ${LABEL} later.`, '2026-11-28T09:59:30Z');
  const edited = note(1, decision.body ?? '', decision.created_at, '2026-11-28T10:10:00Z');
  const v = unappliedNamed({ labels: [], comments: [early, edited], label: LABEL, decisionId: 1, removedAt: REMOVED });
  equal(v.ok, false);
  deepEqual(v.read, []);
});
