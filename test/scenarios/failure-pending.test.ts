import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';
import { resolutionRecord } from '../../scenarios/lib/resolution.ts';
import { awaitFinishedRecord } from '../../scenarios/management/failure-pending.ts';

const PENDING_AT = Date.parse('2026-11-27T10:00:00Z');
const UNFINISHED = "<!-- nibfin:repair -->\nCategory: being classified\nReason: Nibfin's repair agent is looking at this stop";
const FINISHED =
  '<!-- nibfin:repair -->\n分類：維運或人為操作\n原因：.nibfin.json 的 tools 不是陣列。\n\n## 後續建議\n1. 修正 .nibfin.json。';

const record = (body: string, updated: string): Comment => ({
  id: 42,
  body,
  created_at: '2026-11-27T10:01:00Z',
  updated_at: updated,
  user: { login: 'nibfin-bot' },
  html_url: 'https://github.com/o/exec/issues/1#issuecomment-42',
});

/** A fake clock for waitFor, and a read that returns each state in turn and then the last one. */
function setup(states: Comment[][]) {
  let t = 0;
  let reads = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  const read = async () => {
    const cs = states[Math.min(reads++, states.length - 1)] ?? [];
    return { comments: cs, record: resolutionRecord(cs, PENDING_AT) };
  };
  return { clock, read, reads: () => reads };
}

test('the record wait goes on past the unfinished record and accepts the same comment once it names a class', async () => {
  const unfinished = record(UNFINISHED, '2026-11-27T10:01:00Z');
  const s = setup([[], [unfinished], [unfinished], [record(FINISHED, '2026-11-27T10:05:00Z')]]);
  const out = await awaitFinishedRecord(s.read, { what: 'r', deadlineMs: 60_000, intervalMs: 1000, ...s.clock });
  ok('seen' in out);
  equal(out.seen.record?.id, 42);
  equal(out.seen.record?.class, 'operations-or-manual');
  equal(s.reads(), 4);
});

test('the record wait gives the latest unfinished record once the deadline passes, and nothing when none appeared', async () => {
  const s = setup([[record(UNFINISHED, '2026-11-27T10:01:00Z')]]);
  const out = await awaitFinishedRecord(s.read, { what: 'r', deadlineMs: 5000, intervalMs: 1000, ...s.clock });
  ok('last' in out);
  equal(out.last?.record?.url, 'https://github.com/o/exec/issues/1#issuecomment-42');
  equal(out.last?.record?.class, undefined);
  const none = setup([[]]);
  const empty = await awaitFinishedRecord(none.read, { what: 'r', deadlineMs: 5000, intervalMs: 1000, ...none.clock });
  deepEqual(empty, { last: { comments: [], record: undefined } });
});

test('an aborted run ends the record wait with the abort, not a result', async () => {
  const s = setup([[record(UNFINISHED, '2026-11-27T10:01:00Z')]]);
  const ac = new AbortController();
  ac.abort(new Error('stopped'));
  await rejects(
    awaitFinishedRecord(s.read, { what: 'r', deadlineMs: 5000, intervalMs: 1000, signal: ac.signal, ...s.clock }),
    /stopped/,
  );
});
