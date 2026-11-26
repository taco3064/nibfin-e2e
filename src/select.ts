import { parseRuleId } from './coverage.ts';
import { isExcluded } from './types.ts';
import type { MapEntry, RuleId, Scenario } from './types.ts';

export type Selection = { all: true } | { all: false; rules: string[]; sections: string[] };

export interface Selected {
  /** Selected map entries, in map order. */
  entries: MapEntry[];
  /** Selected rules the Proposal marks 〔不測：…〕. */
  excluded: { id: RuleId; reason: string }[];
  /** Scenarios that declare any selected rule, in registry order. */
  scenarios: Scenario[];
}

const SECTION = /^(0|[1-9]\d*)$/;

/** Resolves a selection against the map. `--rule` and `--section` combine as a union. */
export function select(
  entries: MapEntry[],
  scenarios: Scenario[],
  selection: Selection,
): { selected: Selected; errors: string[] } {
  const errors: string[] = [];
  let chosen: MapEntry[];
  if (selection.all) {
    chosen = entries;
  } else {
    const ids = new Set<string>();
    const known = new Set(entries.map((e) => e.id));
    for (const r of selection.rules) {
      if (!parseRuleId(r)) errors.push(`--rule ${r}: not a rule id (expected R<section>.<n>)`);
      else if (!known.has(r)) errors.push(`--rule ${r}: not in the coverage map`);
      else ids.add(r);
    }
    for (const s of selection.sections) {
      if (!SECTION.test(s)) {
        errors.push(`--section ${s}: not a section number`);
        continue;
      }
      const inSection = entries.filter((e) => parseRuleId(e.id)?.section === Number(s));
      if (inSection.length === 0) errors.push(`--section ${s}: no rules in the coverage map`);
      for (const e of inSection) ids.add(e.id);
    }
    chosen = entries.filter((e) => ids.has(e.id));
  }
  const ruleIds = new Set(chosen.filter((e) => !isExcluded(e)).map((e) => e.id));
  return {
    selected: {
      entries: chosen,
      excluded: chosen.flatMap((e) => (isExcluded(e) ? [{ id: e.id, reason: e.notE2e }] : [])),
      scenarios: scenarios.filter((s) => s.rules.some((r) => ruleIds.has(r))),
    },
    errors,
  };
}
