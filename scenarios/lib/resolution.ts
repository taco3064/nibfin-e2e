// The pending resolution stage (Proposal R4.40–R4.52): the delivery gate every resolution
// scenario shares, and a loose reader for the resolution record (R4.49). No rule fixes the
// record's marker or wording, so each part may be missing and each caller decides which
// missing part fails its rule.
import type { GitHub } from '../../src/host/github.ts';
import type { Outcome } from '../../src/types.ts';
import { markerOf, time } from '../lifecycle/analysis.ts';
import type { Comment, Issue } from '../lifecycle/analysis.ts';
import { PENDING_MARKER } from '../lifecycle/marks.ts';
import { redact } from './check.ts';

/** The rule groups a resolution scenario can gate on. */
export type ResolutionGroup = 'stage' | 'dashboard';

const STAGE_ISSUES: [string, number][] = [
  ['taco3064/nibfin-core', 777],
  ['taco3064/nibfin-core', 778],
  ['taco3064/nibfin-core', 779],
  ['taco3064/gh-nibfin', 508],
];

/**
 * The product Issues that deliver each group: `stage` is R4.40–R4.52, `dashboard` is
 * R9.52–R9.56 (which shows the stage's records, so it needs the stage too).
 */
export const RESOLUTION_ISSUES: Record<ResolutionGroup, [string, number][]> = {
  stage: STAGE_ISSUES,
  dashboard: [...STAGE_ISSUES, ['taco3064/gh-nibfin', 509]],
};

const WHAT: Record<ResolutionGroup, string> = {
  stage: 'the pending resolution stage (R4.40–R4.52)',
  dashboard: 'the pending resolution Dashboard (R9.52–R9.56)',
};

/**
 * `waiting` (Proposal R8.20) naming the group's delivering Issues not closed with
 * `delivered`, or undefined once all are. A read error propagates; it is never `waiting`.
 */
export async function resolutionGate(
  gh: GitHub,
  group: ResolutionGroup,
  issues: Record<ResolutionGroup, [string, number][]> = RESOLUTION_ISSUES,
): Promise<Outcome | undefined> {
  const list = issues[group];
  if (!list.length)
    return { status: 'waiting', reason: `${WHAT[group]} is not delivered yet: no delivering product Issue is listed` };
  const open: string[] = [];
  for (const [repo, n] of list) {
    const { data } = await gh.rest<Issue>('GET', `/repos/${repo}/issues/${n}`);
    if (!(data.state === 'closed' && data.labels.some((l) => l.name === 'delivered'))) open.push(`${repo}#${n}`);
  }
  return open.length
    ? { status: 'waiting', reason: `${WHAT[group]} is not delivered yet: ${open.join(', ')} not closed with delivered` }
    : undefined;
}

interface IssueEvent {
  event: string;
  created_at: string;
  label?: { name: string };
}

/** The time `label` was last added, from an Issue's events, or undefined. */
export function labelAddedAt(events: IssueEvent[], label: string): number | undefined {
  const ts = events.filter((e) => e.event === 'labeled' && e.label?.name === label).map((e) => time(e.created_at));
  return ts.length ? Math.max(...ts) : undefined;
}

/** When `pending` was last added to Issue `n` (its `labeled` events); throws when it never was. */
export async function pendingAddedAt(gh: GitHub, repo: string, n: number): Promise<number> {
  const at = labelAddedAt(await gh.list<IssueEvent>(`/repos/${repo}/issues/${n}/events`), 'pending');
  if (at === undefined) throw new Error(`${repo}#${n} has no labeled event for pending`);
  return at;
}

export type ResolutionClassId =
  | 'external-temporary'
  | 'unrelated-flaky-test'
  | 'nibfin-flow-error'
  | 'issue-correction'
  | 'product-decision'
  | 'operations-or-manual';

/** The six cause classes of Proposal R4.41, each matched loosely in Chinese or English. */
export const RESOLUTION_CLASSES: { id: ResolutionClassId; name: string; pattern: RegExp }[] = [
  {
    id: 'external-temporary',
    name: '外部暫時性問題',
    pattern: /外部.{0,3}暫時|external[\s-]+(temporary|transient)|transient[\s-]+external|external-temporary/i,
  },
  {
    id: 'unrelated-flaky-test',
    name: '與該 Issue 無關的偶發測試失敗',
    pattern:
      /偶發.{0,3}測試|無關.{0,12}測試失敗|(unrelated|flaky|intermittent)[\s-]+(\w+[\s-]+)?tests?\b|unrelated-flaky-test/i,
  },
  {
    id: 'nibfin-flow-error',
    name: 'Nibfin 自身的流程錯誤',
    pattern:
      /流程錯誤|nibfin(['’]s)?[\s-]+(own[\s-]+)?(flow|process|workflow)[\s-]+(error|failure|fault)|nibfin-flow-error/i,
  },
  {
    id: 'issue-correction',
    name: 'Issue 規格需修正',
    pattern:
      /規格.{0,2}修正|issue[\s-]+(spec(ification)?|text|body)[\s-]+(needs?[\s-]+)?(fix|correct|amend)\w*|spec(ification)?[\s-]+(fix|correction)|issue-correction/i,
  },
  { id: 'product-decision', name: '產品決策', pattern: /產品決策|product[\s-]+decision/i },
  {
    id: 'operations-or-manual',
    name: '維運或人為操作',
    pattern:
      /維運|人為操作|operations?[\s-]*(or|\/|&|and)[\s-]*(manual|human)|manual[\s-]+(action|operation|intervention|fix)|human[\s-]+(action|operation|intervention)|operations-or-manual/i,
  },
];

/** The class named earliest in `text`, or undefined. */
export function classIn(text: string): ResolutionClassId | undefined {
  let best: { id: ResolutionClassId; at: number } | undefined;
  for (const c of RESOLUTION_CLASSES) {
    const m = c.pattern.exec(text);
    if (m && (!best || m.index < best.at)) best = { id: c.id, at: m.index };
  }
  return best?.id;
}

export interface ResolutionOption {
  n: number;
  text: string;
  recommended: boolean;
}

export interface ResolutionRecord {
  id: number;
  url: string;
  key: string;
  /** The latest time the record was written or updated. */
  at: number;
  body: string;
  /** The class's own text from a labelled line, when there is one. */
  classLabel?: string;
  class?: ResolutionClassId;
  cause?: string;
  options: ResolutionOption[];
  /** The number of the option marked as recommended (R4.45). */
  recommended?: number;
  /** Whether the record gives next steps (R4.46). */
  nextSteps: boolean;
}

const lastWrite = (c: Comment) => Math.max(time(c.created_at), time(c.updated_at));

/** Whether a marked comment is a resolution record rather than the `pending` comment or another mark. */
function isRecord(c: Comment): boolean {
  const key = markerOf(c.body);
  if (!key || PENDING_MARKER.test(key)) return false;
  return /^repair\b/.test(key) || classIn(c.body ?? '') !== undefined;
}

/** Every resolution record written or updated at or after `pendingAt`, oldest first. */
export function resolutionRecords(comments: Comment[], pendingAt: number): Comment[] {
  return comments
    .filter((c) => isRecord(c) && lastWrite(c) >= pendingAt)
    .sort((a, b) => lastWrite(a) - lastWrite(b) || a.id - b.id);
}

/** The latest resolution record after `pendingAt`, parsed, or undefined. */
export function resolutionRecord(comments: Comment[], pendingAt: number): ResolutionRecord | undefined {
  const c = resolutionRecords(comments, pendingAt).at(-1);
  return c && parseRecord(c);
}

const CLASS_LABEL = /^(分類|類別|原因分類|category|class(ification)?)$/i;
const CAUSE_LABEL = /^(一句話原因|原因|reason|cause)$/i;
const NEXT_HEADING = /後續建議|下一步|建議步驟|後續步驟|next[\s-]*steps?|follow[\s-]*up|advice/i;
const OPTIONS_HEADING = /選項|\boptions?\b|\bchoices?\b/i;
const NUMBERED = /^(\d+)\s*[.)、:：]\s*(.+)$/;
const OPTION_LINE = /^(?:選項|option)\s*(\d+)\s*[.)、:：-]?\s*(.*)$/i;
const RECOMMENDED = /建議|推薦|recommend/i;

/** A line without list, quote, heading and emphasis marks. */
const plain = (line: string) =>
  line
    .replace(/^[\s>#*_-]+/, '')
    .replace(/\*\*|__/g, '')
    .trim();

/** `label: value` (value may be empty) when the line is a field, else undefined. */
function field(line: string): { label: string; value: string } | undefined {
  const m = /^([^:：]{1,30}?)\s*[:：]\s*(.*)$/.exec(plain(line));
  return m ? { label: (m[1] ?? '').trim(), value: (m[2] ?? '').trim() } : undefined;
}

/** A heading: a markdown heading, a line wholly in bold, or a label ending in a colon. */
function headingOf(line: string): string | undefined {
  const t = line.trim();
  if (/^#{1,6}\s/.test(t) || /^\*\*[^*]+\*\*[:：]?$/.test(t))
    return plain(t)
      .replace(/[:：]$/, '')
      .trim();
  const f = field(t);
  if (f && !f.value && !NUMBERED.test(plain(t))) return f.label;
  return undefined;
}

/** Parses the parts of one record (R4.49); each part may be missing. */
export function parseRecord(c: Comment): ResolutionRecord {
  const body = c.body ?? '';
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  let classLabel: string | undefined;
  let cause: string | undefined;
  let nextSteps = false;
  const options: ResolutionOption[] = [];
  let section: 'options' | 'next' | 'other' = 'other';
  let wanted: 'class' | 'cause' | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    const heading = headingOf(line);
    if (heading !== undefined) {
      wanted = CLASS_LABEL.test(heading) ? 'class' : CAUSE_LABEL.test(heading) ? 'cause' : undefined;
      section = NEXT_HEADING.test(heading) ? 'next' : OPTIONS_HEADING.test(heading) ? 'options' : 'other';
      continue;
    }
    const text = plain(line);
    if (wanted === 'class' && classLabel === undefined) classLabel = text;
    if (wanted === 'cause' && cause === undefined) cause = text;
    wanted = undefined;
    const f = field(line);
    if (f && f.value) {
      if (CLASS_LABEL.test(f.label) && classLabel === undefined) classLabel = f.value;
      else if (CAUSE_LABEL.test(f.label) && cause === undefined) cause = f.value;
      else if (NEXT_HEADING.test(f.label)) nextSteps = true;
    }
    if (section === 'next') {
      nextSteps = true;
      continue;
    }
    const opt = OPTION_LINE.exec(text) ?? (section === 'options' ? NUMBERED.exec(text) : null);
    if (opt) {
      const rest = (opt[2] ?? '').trim();
      options.push({ n: Number(opt[1]), text: rest, recommended: RECOMMENDED.test(rest) });
    }
  }
  const cls = classIn(classLabel ?? body);
  const recommended = options.find((o) => o.recommended)?.n;
  return {
    id: c.id,
    url: c.html_url,
    key: markerOf(body) ?? '',
    at: lastWrite(c),
    body,
    ...(classLabel !== undefined ? { classLabel } : {}),
    ...(cls ? { class: cls } : {}),
    ...(cause !== undefined ? { cause } : {}),
    options,
    ...(recommended !== undefined ? { recommended } : {}),
    nextSteps,
  };
}

/** A record shortened for a failure message: no HTML comments, one line, capped, secrets hidden. */
export function briefRecord(body: string, max = 300): string {
  const t = redact(
    body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return t.length > max ? t.slice(0, max) + '…' : t;
}
