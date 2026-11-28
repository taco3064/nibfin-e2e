// resolution-decision's pure checks (Issue #552, Proposal R4.45, R4.51): the options of a
// product-decision record, resolving an option to one rounding rule, the choice, and
// whether the body stayed unchanged or reflects the chosen rule.
import { deepEqual, equal, ok } from 'node:assert/strict';
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
  recordProgress,
  recordWaitReason,
  reflects,
} from '../../scenarios/lifecycle/resolution-decision.ts';
import { briefRecord, parseRecord } from '../../scenarios/lib/resolution.ts';

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

// awaitResolutionRecord's pure parts: it waits past an unfinished record (no class yet),
// accepts the same comment once updated in place with a class, and names an unfinished
// record at the deadline (Proposal R3.42, R4.41, R9.52, R1.14).
const PENDING_AT = Date.parse('2026-11-27T00:00:00Z');
const UNFINISHED = [
  '<!-- nibfin:repair -->',
  'Category: being classified',
  "Reason: Nibfin's repair agent is looking at this stop",
].join('\n');
const FINISHED = ['<!-- nibfin:repair -->', '分類：產品決策', '選項：', '1. 五成雙（建議）', '2. 遠離零'].join('\n');
const comment = (id: number, body: string, created: string, updated = created) =>
  ({
    id,
    body,
    created_at: created,
    updated_at: updated,
    user: null,
    html_url: `https://example.test/c/${id}`,
  }) as Comment;

test('recordProgress reports an unfinished latest record, a finished one, and no record', () => {
  const u = recordProgress([comment(1, UNFINISHED, '2026-11-27T00:01:00Z')], PENDING_AT);
  equal(u.done, undefined);
  equal(u.unfinished?.id, 1);
  const d = recordProgress([comment(2, FINISHED, '2026-11-27T00:01:00Z')], PENDING_AT);
  equal(d.unfinished, undefined);
  equal(d.done?.class, 'product-decision');
  deepEqual(recordProgress([], PENDING_AT), {});
  deepEqual(recordProgress([comment(3, FINISHED, '2026-11-26T23:59:00Z')], PENDING_AT), {});
});

test('recordProgress accepts the same comment once it is updated in place with a class', () => {
  const before = recordProgress([comment(7, UNFINISHED, '2026-11-27T00:01:00Z')], PENDING_AT);
  equal(before.unfinished?.id, 7);
  const after = recordProgress([comment(7, FINISHED, '2026-11-27T00:01:00Z', '2026-11-27T00:05:00Z')], PENDING_AT);
  equal(after.done?.id, 7);
  equal(after.done?.class, 'product-decision');
});

test('recordProgress lets the latest record decide when an unfinished one follows a finished one', () => {
  const p = recordProgress(
    [comment(1, FINISHED, '2026-11-27T00:01:00Z'), comment(2, UNFINISHED, '2026-11-27T00:02:00Z')],
    PENDING_AT,
  );
  equal(p.done, undefined);
  equal(p.unfinished?.id, 2);
});

test('recordWaitReason names and quotes an unfinished record at the deadline, else keeps the generic reason', () => {
  const unfinished = recordProgress([comment(9, UNFINISHED, '2026-11-27T00:01:00Z')], PENDING_AT).unfinished;
  const base = { n: 5, pendingAt: PENDING_AT, keys: ['repair'], cause: 'timed out after 30m' };
  const late = recordWaitReason({ ...base, unfinished, timedOut: true });
  ok(late.includes('https://example.test/c/9'), late);
  ok(late.includes('never named a class'), late);
  ok(late.includes(briefRecord(UNFINISHED)), late);
  ok(late.includes('timed out after 30m'), late);
  const generic = `no resolution record on #5 after pending was added at 2026-11-27T00:00:00.000Z (timed out after 30m); marker keys seen after it: repair`;
  equal(recordWaitReason({ ...base, unfinished, timedOut: false }), generic);
  equal(recordWaitReason({ ...base, timedOut: true }), generic);
  ok(recordWaitReason({ ...base, keys: [], timedOut: true }).endsWith('marker keys seen after it: none'));
});
