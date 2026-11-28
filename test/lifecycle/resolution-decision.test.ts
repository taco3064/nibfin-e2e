// resolution-decision's pure checks (Issue #552, Proposal R4.45, R4.51): the options of a
// product-decision record, resolving an option to one rounding rule, the choice, and
// whether the body stayed unchanged or reflects the chosen rule.
import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';
import {
  DECISION_EXTRA,
  ROUNDING_RULES,
  bodyUnchanged,
  chooseOption,
  decisionBody,
  optionProblems,
  optionRule,
  reflects,
} from '../../scenarios/lifecycle/resolution-decision.ts';
import { parseRecord } from '../../scenarios/lib/resolution.ts';

const record = (body: string) =>
  parseRecord({
    id: 1,
    body,
    created_at: '2026-11-27T00:00:00Z',
    updated_at: '2026-11-27T00:00:00Z',
    user: null,
    html_url: 'u',
  } as Comment);
const zh = (...opts: string[]) =>
  record(
    [
      '<!-- nibfin:repair -->',
      '分類：產品決策',
      '原因：進位規則未定',
      '選項：',
      ...opts.map((o, i) => `${i + 1}. ${o}`),
    ].join('\n'),
  );
const en = (...opts: string[]) =>
  record(
    ['<!-- nibfin:repair -->', 'Class: product decision', 'Options:', ...opts.map((o, i) => `${i + 1}. ${o}`)].join(
      '\n',
    ),
  );

test('optionProblems accepts 2, 3 and 4 options with one recommended', () => {
  deepEqual(optionProblems(zh('五成雙（建議）：2.5→2，Issue 寫明', '遠離零：2.5→3')), []);
  deepEqual(
    optionProblems(en('Half to even (recommended): 2.5 → 2', 'Away from zero: 2.5 → 3', 'Half up: -2.5 → -2')),
    [],
  );
  deepEqual(optionProblems(zh('五成雙（建議）：2.5→2', '遠離零：2.5→3', '向零：2.5→2', '正無窮：-2.5→-2')), []);
});

test('optionProblems rejects 1 or 5 options, zero or two recommended, an empty option and repeated numbers', () => {
  equal(optionProblems(zh('五成雙（建議）：2.5→2')).length, 1);
  equal(optionProblems(zh('a 建議 x', 'bb', 'cc', 'dd', 'ee')).length, 1);
  equal(optionProblems(zh('五成雙：2.5→2', '遠離零：2.5→3')).length, 1);
  equal(optionProblems(zh('五成雙（建議）', '遠離零（建議）')).length, 1);
  equal(optionProblems(en('Half to even (recommended): 2.5 → 2', '-')).length, 1);
  const dup = record(
    ['<!-- nibfin:repair -->', '分類：產品決策', '選項：', '1. 五成雙（建議）', '1. 遠離零'].join('\n'),
  );
  equal(optionProblems(dup).length, 1);
});

test('optionRule resolves an option to exactly one rule', () => {
  equal(optionRule('五成雙：2.5→2'), 'half-even');
  equal(optionRule("Half to even (banker's): 2.5→2, unlike half away from zero"), 'half-even');
  equal(optionRule('遠離零：2.5→3，不同於五成雙'), 'half-away');
  equal(optionRule('（建議）half up, so -2.5 → -2'), 'half-up');
  equal(optionRule('Rounding: half down gives 2, unlike away from zero'), 'half-down');
  equal(optionRule('Half to even or away from zero: either'), undefined);
  equal(optionRule('四捨五入'), undefined);
  equal(optionRule('無條件進位'), undefined);
  equal(optionRule('向上取整'), undefined);
});

test('chooseOption prefers a non-recommended option, falls back to the recommended one, and needs a resolvable rule', () => {
  const r = zh('五成雙（建議）：2.5→2', '遠離零：2.5→3');
  deepEqual(chooseOption(r, 'old'), { option: r.options[1], rule: 'half-away' });
  const only = zh('五成雙（建議）：2.5→2', '四捨五入：2.5→3');
  deepEqual(chooseOption(only, 'old'), { option: only.options[0], rule: 'half-even' });
  equal(chooseOption(zh('四捨五入（建議）', '無條件進位'), 'old'), undefined);
  equal(chooseOption(zh('五成雙（建議）', '遠離零'), 'away from zero 遠離零 遠離0')?.rule, 'half-even');
});

test('reflects needs a new term of the chosen rule only', () => {
  const old = decisionBody('e2e-round-r1');
  equal(reflects(old, `${old}\n\nExact halves round half to even.`, 'half-even'), true);
  equal(reflects(old, `${old}\n\n一半時五成雙。`, 'half-even'), true);
  equal(reflects(old, old, 'half-even'), false);
  equal(reflects(old, `${old}\n\nHalves round away from zero.`, 'half-even'), false);
  equal(
    reflects(
      old,
      `${old}\n\nHalves round half away from zero.`,
      optionRule("Half to even (banker's), unlike half away from zero") ?? 'half-even',
    ),
    false,
  );
  equal(reflects('round half to even', 'round half to even, always', 'half-even'), false);
});

test('bodyUnchanged ignores line endings and trailing whitespace and catches an edit', () => {
  equal(bodyUnchanged('a\r\nb  \r\n', 'a\nb'), true);
  equal(bodyUnchanged('a\nb', 'a\nc'), false);
});

test('the fixture text names no rounding rule', () => {
  for (const text of [DECISION_EXTRA, decisionBody('e2e-round-r1')]) {
    for (const r of ROUNDING_RULES)
      for (const t of r.terms) equal(t.test(text), false, `${r.id} ${String(t)} in ${text}`);
  }
});
