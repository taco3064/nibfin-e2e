import { parseRuleId } from '../coverage.ts';
import type { MapEntry, RuleId } from '../types.ts';

const ID = 'R(?:0|[1-9]\\d*)\\.[1-9]\\d*';
const SHAPE_LINE = new RegExp(`^Proposal rules: (none|${ID}(?:, ${ID})*)$`);
const PREFIX = 'Proposal rules:';

export type ShapeLine =
  | { state: 'line'; ids: RuleId[] }
  | { state: 'none' }
  | { state: 'missing-line' }
  | { state: 'malformed-line'; text: string };

/**
 * Reads the approved Shape's one `Proposal rules:` line, written from the first column
 * (format set by nibfin-core's `.nibfin/proposal-rules-shape.md`).
 */
export function parseShapeLine(body: string): ShapeLine {
  const lines = body
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.startsWith(PREFIX));
  if (lines.length === 0) return { state: 'missing-line' };
  if (lines.length > 1) return { state: 'malformed-line', text: lines.join('\n') };
  const line = lines[0] as string;
  const m = SHAPE_LINE.exec(line);
  if (!m) return { state: 'malformed-line', text: line };
  if (m[1] === 'none') return { state: 'none' };
  return { state: 'line', ids: [...new Set(line.slice(PREFIX.length + 1).split(', '))] };
}

/** The text under the `## Authority` heading, up to the next `## ` heading or the end; undefined without the heading. */
export function authoritySection(body: string): string | undefined {
  const lines = body.split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => /^## Authority\s*$/.test(l));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

const CITATION = /(?<![A-Za-z0-9])R(\d+)\.(\d+)(?:\s*[–-]\s*R(\d+)\.(\d+))?|§\s?(\d+)(?:\s*[–-]\s*§\s?(\d+))?/g;

export interface Citations {
  /** Cited rule ids in map order, then cited ids the map does not hold, in citation order. */
  ids: RuleId[];
  /** Cited section numbers (`§`), in citation order. */
  sections: number[];
}

/**
 * Collects the rules an Issue cites under `## Authority`: `R<s>.<n>` ids, ranges
 * `R<s>.<a>–R<s>.<b>` (expanded to the map ids of that section with a ≤ n ≤ b), and
 * `§<n>` or `§<a>–§<b>` (expanded to every map id in those sections).
 */
export function authorityCitations(body: string, entries: MapEntry[]): Citations {
  const text = authoritySection(body) ?? '';
  const ids = new Set<string>();
  const sections: number[] = [];
  const inMap = (pred: (p: { section: number; n: number }) => boolean) => {
    for (const e of entries) {
      const p = parseRuleId(e.id);
      if (p && pred(p)) ids.add(e.id);
    }
  };
  for (const m of text.matchAll(CITATION)) {
    if (m[1] !== undefined) {
      const from = `R${m[1]}.${m[2]}`;
      const a = parseRuleId(from);
      if (!a) continue;
      if (m[3] === undefined) {
        ids.add(from);
        continue;
      }
      const to = `R${m[3]}.${m[4]}`;
      const b = parseRuleId(to);
      if (b && b.section === a.section && b.n >= a.n) {
        inMap((p) => p.section === a.section && p.n >= a.n && p.n <= b.n);
      } else {
        ids.add(from);
        if (b) ids.add(to);
      }
    } else {
      const a = Number(m[5]);
      const b = m[6] === undefined ? a : Number(m[6]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let s = lo; s <= hi; s++) if (!sections.includes(s)) sections.push(s);
      inMap((p) => p.section >= lo && p.section <= hi);
    }
  }
  const known = entries.filter((e) => ids.has(e.id)).map((e) => e.id);
  const knownSet = new Set(known);
  return { ids: [...known, ...[...ids].filter((id) => !knownSet.has(id))], sections };
}
