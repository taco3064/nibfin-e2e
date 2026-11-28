import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';
import {
  briefRecord,
  labelAddedAt,
  labelRemovedAt,
  RESOLUTION_ISSUES,
  resolutionGate,
  resolutionRecord,
  resolutionRecords,
} from '../../scenarios/lib/resolution.ts';
import { routes } from '../lifecycle/fake.ts';

const PENDING_AT = Date.parse('2026-11-27T10:00:00Z');
let nextId = 1;
const comment = (body: string, created: string, updated = created): Comment => ({
  id: nextId++,
  body,
  created_at: created,
  updated_at: updated,
  user: { login: 'nibfin-bot' },
  html_url: `https://github.com/o/exec/issues/1#issuecomment-${nextId}`,
});

const delivered = { state: 'closed', labels: [{ name: 'delivered' }] };

test('the resolution gate is waiting and names the delivering Issues not closed with delivered', async () => {
  const table: Record<string, object> = {};
  for (const [repo, n] of RESOLUTION_ISSUES.dashboard) table[`GET /repos/${repo}/issues/${n}`] = delivered;
  table['GET /repos/taco3064/nibfin-core/issues/778'] = { state: 'open', labels: [{ name: 'scope' }] };
  table['GET /repos/taco3064/gh-nibfin/issues/508'] = { state: 'closed', labels: [] };
  deepEqual(await resolutionGate(routes(table).github, 'stage'), {
    status: 'waiting',
    reason:
      'the pending resolution stage (R4.40–R4.52) is not delivered yet: taco3064/nibfin-core#778, taco3064/gh-nibfin#508 not closed with delivered',
  });
  table['GET /repos/taco3064/nibfin-core/issues/778'] = delivered;
  table['GET /repos/taco3064/gh-nibfin/issues/508'] = delivered;
  equal(await resolutionGate(routes(table).github, 'stage'), undefined);
  equal(await resolutionGate(routes(table).github, 'dashboard'), undefined);
  table['GET /repos/taco3064/gh-nibfin/issues/509'] = { state: 'open', labels: [] };
  equal(await resolutionGate(routes(table).github, 'stage'), undefined);
  match(
    (await resolutionGate(routes(table).github, 'dashboard'))?.reason ?? '',
    /Dashboard .*gh-nibfin#509 not closed with delivered/,
  );
});

test('the resolution gate is waiting when no delivering Issue is listed, and a read error is never waiting', async () => {
  deepEqual(await resolutionGate(routes({}).github, 'stage', { stage: [], dashboard: [] }), {
    status: 'waiting',
    reason: 'the pending resolution stage (R4.40–R4.52) is not delivered yet: no delivering product Issue is listed',
  });
  await rejects(resolutionGate(routes({}).github, 'stage'));
});

test('the decision group waits on the amended R4.51 delivery and opens when all are delivered', async () => {
  const table: Record<string, object> = {};
  for (const [repo, n] of RESOLUTION_ISSUES.decision) table[`GET /repos/${repo}/issues/${n}`] = delivered;
  table['GET /repos/taco3064/nibfin-core/issues/810'] = { state: 'open', labels: [{ name: 'scope' }] };
  match(
    (await resolutionGate(routes(table).github, 'decision'))?.reason ?? '',
    /amended decision reading of R4\.51 .*taco3064\/nibfin-core#810 not closed with delivered$/,
  );
  equal(await resolutionGate(routes(table).github, 'stage'), undefined);
  table['GET /repos/taco3064/nibfin-core/issues/810'] = delivered;
  equal(await resolutionGate(routes(table).github, 'decision'), undefined);
  equal((await resolutionGate(routes({}).github, 'decision', { stage: [] }))?.status, 'waiting');
});

test('the time pending was removed is its latest unlabeled event', () => {
  const events = [
    { event: 'unlabeled', created_at: '2026-11-27T09:30:00Z', label: { name: 'pending' } },
    { event: 'labeled', created_at: '2026-11-27T09:45:00Z', label: { name: 'pending' } },
    { event: 'unlabeled', created_at: '2026-11-27T10:00:00Z', label: { name: 'pending' } },
    { event: 'unlabeled', created_at: '2026-11-27T11:00:00Z', label: { name: 'scope' } },
  ];
  equal(labelRemovedAt(events, 'pending'), PENDING_AT);
  equal(labelRemovedAt(events.slice(1, 2), 'pending'), undefined);
});

test('the time pending was added is its latest labeled event', () => {
  const events = [
    { event: 'labeled', created_at: '2026-11-27T09:00:00Z', label: { name: 'pending' } },
    { event: 'unlabeled', created_at: '2026-11-27T09:30:00Z', label: { name: 'pending' } },
    { event: 'labeled', created_at: '2026-11-27T10:00:00Z', label: { name: 'scope' } },
    { event: 'labeled', created_at: '2026-11-27T10:00:00Z', label: { name: 'pending' } },
  ];
  equal(labelAddedAt(events, 'pending'), PENDING_AT);
  equal(labelAddedAt(events.slice(1, 3), 'pending'), undefined);
});

const ZH = `<!-- nibfin:repair -->
## 排除紀錄

**分類**：維運或人為操作
**原因**：.nibfin.json 的 tools 欄位不是陣列，Core 拒絕執行 Job。
**依據**：pending 留言的原因 code config-invalid。
**已做的處理**：無。

### 後續建議
1. 修正 \`.nibfin.json\`，把 \`tools\` 改成陣列。
2. 執行 \`gh nibfin doctor\` 確認設定。
3. 移除 \`pending\`。
`;

const EN = `<!-- nibfin:repair -->
**Category:** Product decision
**Reason:** the Issue asks for two behaviours that cannot both hold.
**Basis:** the Shape review.

**Options**
1. Keep the old flag; the Issue drops part B.
2. Replace the flag (recommended); the Issue's Expected outcome changes.
3. Ship both behind a setting.

Reply with the option number.
`;

test('the record reader finds the record after pending and ignores the pending comment, unmarked comments and older records', () => {
  const pending = comment(
    '<!-- nibfin:pending -->\nThe Job failed: .nibfin.json is invalid (維運或人為操作).',
    '2026-11-27T09:59:58Z',
    '2026-11-27T10:00:05Z',
  );
  const plain = comment('分類：產品決策 — a person typing', '2026-11-27T10:01:00Z');
  const old = comment('<!-- nibfin:repair -->\n分類：外部暫時性問題', '2026-11-27T09:00:00Z');
  const record = comment(ZH, '2026-11-27T10:02:00Z');
  const cs = [pending, plain, old, record];
  deepEqual(
    resolutionRecords(cs, PENDING_AT).map((x) => x.id),
    [record.id],
  );
  const r = resolutionRecord(cs, PENDING_AT);
  equal(r?.id, record.id);
  equal(r?.key, 'repair');
  equal(resolutionRecord([pending, plain, old], PENDING_AT), undefined);
});

test('an older record updated after pending counts, and a marked comment naming a class counts without the repair key', () => {
  const updated = comment(
    '<!-- nibfin:repair -->\n分類：外部暫時性問題\n原因：GitHub 回 502。',
    '2026-11-27T09:00:00Z',
    '2026-11-27T10:03:00Z',
  );
  equal(resolutionRecord([updated], PENDING_AT)?.class, 'external-temporary');
  const other = comment(
    '<!-- nibfin:resolution -->\nClass: operations or manual action\nCause: the config is invalid.',
    '2026-11-27T10:04:00Z',
  );
  deepEqual(
    resolutionRecords([updated, other], PENDING_AT).map((x) => x.id),
    [updated.id, other.id],
  );
  equal(resolutionRecord([updated, other], PENDING_AT)?.class, 'operations-or-manual');
  const unrelated = comment('<!-- nibfin:shape -->\n## Goal\nAdd a flag.', '2026-11-27T10:05:00Z');
  equal(resolutionRecords([unrelated], PENDING_AT).length, 0);
});

test('a Chinese record gives its class, cause and next steps; numbered next steps are not options', () => {
  const r = resolutionRecord([comment(ZH, '2026-11-27T10:02:00Z')], PENDING_AT);
  equal(r?.classLabel, '維運或人為操作');
  equal(r?.class, 'operations-or-manual');
  equal(r?.cause, '.nibfin.json 的 tools 欄位不是陣列，Core 拒絕執行 Job。');
  deepEqual(r?.options, []);
  equal(r?.recommended, undefined);
  equal(r?.nextSteps, true);
});

test('an English record gives its class, cause and numbered options with the recommended one', () => {
  const r = resolutionRecord([comment(EN, '2026-11-27T10:02:00Z')], PENDING_AT);
  equal(r?.class, 'product-decision');
  equal(r?.cause, 'the Issue asks for two behaviours that cannot both hold.');
  deepEqual(
    r?.options.map((o) => [o.n, o.recommended]),
    [
      [1, false],
      [2, true],
      [3, false],
    ],
  );
  equal(r?.recommended, 2);
  equal(r?.nextSteps, false);
});

test('options written as 選項 N, headings on their own line, and English next steps', () => {
  const zh = `<!-- nibfin:repair -->
## 分類
產品決策

## 原因
兩個需求互相矛盾。

- 選項 1：保留舊行為。
- 選項 2（建議）：改成新行為。
`;
  const r = resolutionRecord([comment(zh, '2026-11-27T10:02:00Z')], PENDING_AT);
  equal(r?.class, 'product-decision');
  equal(r?.cause, '兩個需求互相矛盾。');
  deepEqual(
    r?.options.map((o) => o.n),
    [1, 2],
  );
  equal(r?.recommended, 2);
  const en = `<!-- nibfin:repair -->
Classification: Nibfin's own flow error
Cause: the rerun failed again.

Next steps:
1. Report this run to Nibfin.
`;
  const e = resolutionRecord([comment(en, '2026-11-27T10:02:00Z')], PENDING_AT);
  equal(e?.class, 'nibfin-flow-error');
  equal(e?.nextSteps, true);
  deepEqual(e?.options, []);
  const bare = resolutionRecord(
    [comment('<!-- nibfin:repair -->\nSomething happened.', '2026-11-27T10:02:00Z')],
    PENDING_AT,
  );
  equal(bare?.class, undefined);
  equal(bare?.cause, undefined);
  equal(bare?.nextSteps, false);
});

test('an unknown class keeps its label and gives no class', () => {
  const r = resolutionRecord(
    [comment('<!-- nibfin:repair -->\n分類：其他\n原因：不明。', '2026-11-27T10:02:00Z')],
    PENDING_AT,
  );
  equal(r?.classLabel, '其他');
  equal(r?.class, undefined);
});

test('briefRecord drops markers, hides token-shaped strings and caps the length', () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const b = briefRecord(`<!-- nibfin:repair -->\n分類：維運或人為操作\n\nuse ${token} now ${'x'.repeat(400)}`);
  equal(b.includes(token), false);
  equal(b.includes('nibfin:repair'), false);
  match(b, /^分類：維運或人為操作 use <token> now x+…$/);
  equal(b.length, 301);
});
