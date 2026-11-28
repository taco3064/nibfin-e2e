import { computeCoverage } from '../coverage.ts';
import { WATCHED_REPOS } from '../host/config.ts';
import type { GitHub } from '../host/github.ts';
import { select } from '../select.ts';
import { isExcluded } from '../types.ts';
import type { MapEntry, Platform, RuleId, Scenario } from '../types.ts';
import type { WaitingRule } from '../run.ts';
import { authorityCitations } from './citations.ts';
import { decisionTable } from './decisions.ts';
import type { Decision } from './decisions.ts';
import { readImpact } from './impact.ts';
import type { ChangeContext, ImpactSource, IssueRef } from './impact.ts';

export type PlanRequest =
  { mode: 'delivered'; ref: IssueRef } | { mode: 'select'; rules: string[]; sections: string[] } | { mode: 'all' };

export const NOT_IN_MAP = 'not in coverage-map.json';

export interface Gap {
  id: RuleId;
  /** The required platforms without a scenario, or why the rule has none. */
  missing: Platform[] | typeof NOT_IN_MAP;
}

export interface Plan {
  mode: PlanRequest['mode'];
  source: ImpactSource | null;
  /** What the harness runs (`npm run e2e -- --plan`). */
  selection: { all: true } | { all: false; rules: RuleId[] };
  waiting: WaitingRule[];
  excluded: { id: RuleId; reason: string }[];
  /** Selected ids the coverage map does not hold. */
  unknown: RuleId[];
  /** Selected rules without a scenario; each files one `request`. Empty in `--all` mode. */
  gaps: Gap[];
  /** Every other uncovered map rule; listed only. */
  unselectedGaps: { id: RuleId; missingPlatforms: Platform[] }[];
  coverage: { passed: boolean; covered: number; total: number };
  execute: boolean;
  decisions: Decision[];
  summary: string;
}

interface ScopeIssue {
  html_url?: string;
  body?: string | null;
  pull_request?: unknown;
}

/** Rules cited by open `scope` Issues in the watched repositories: the Proposal is ahead of the implementation. */
async function openScopeCitations(gh: GitHub, entries: MapEntry[]): Promise<Map<RuleId, string[]>> {
  const out = new Map<RuleId, string[]>();
  for (const repo of WATCHED_REPOS) {
    const issues = await gh.list<ScopeIssue>(`/repos/${repo}/issues?state=open&labels=scope`);
    for (const issue of issues) {
      if (issue.pull_request) continue;
      for (const id of authorityCitations(issue.body ?? '', entries).ids) {
        const list = out.get(id) ?? [];
        if (issue.html_url && !list.includes(issue.html_url)) list.push(issue.html_url);
        out.set(id, list);
      }
    }
  }
  return out;
}

export type PlanOutcome = { plan: Plan } | { usage: string[] };

/**
 * Decides what to rerun from GitHub state; the result is printed as one JSON document.
 * `sources` reads the checkout's `scenarios/**` files for a nibfin-e2e Issue's changed scenarios.
 */
export async function makePlan(
  gh: GitHub,
  entries: MapEntry[],
  scenarios: Scenario[],
  request: PlanRequest,
  sources: ChangeContext['sources'] = () => [],
): Promise<PlanOutcome> {
  const decisions: Decision[] = [];
  let source: ImpactSource | null = null;
  let ids: RuleId[];
  if (request.mode === 'delivered') {
    const impact = await readImpact(gh, request.ref, entries, { scenarios, sources });
    source = impact.source;
    ids = impact.ids;
    decisions.push(...impact.decisions);
  } else if (request.mode === 'select') {
    const { selected, errors } = select(entries, scenarios, {
      all: false,
      rules: request.rules,
      sections: request.sections,
    });
    if (errors.length) return { usage: errors };
    ids = selected.entries.map((e) => e.id);
    decisions.push({
      subject: 'selection',
      decision: 'explicit',
      reason: [...request.rules.map((r) => `--rule ${r}`), ...request.sections.map((s) => `--section ${s}`)].join(' '),
    });
  } else {
    ids = entries.map((e) => e.id);
    decisions.push({
      subject: 'selection',
      decision: '--all',
      reason: 'every rule in coverage-map.json (pre-release run)',
    });
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  const cited = ids.length ? await openScopeCitations(gh, entries) : new Map<RuleId, string[]>();
  const waiting: WaitingRule[] = [];
  const excluded: Plan['excluded'] = [];
  const unknown: RuleId[] = [];
  const runnable: MapEntry[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry && isExcluded(entry)) {
      excluded.push({ id, reason: entry.notE2e });
      decisions.push({ subject: id, decision: 'not run', reason: `the Proposal marks it 〔不測：${entry.notE2e}〕` });
      continue;
    }
    const issues = cited.get(id);
    if (issues) {
      waiting.push({ id, issues });
      decisions.push({ subject: id, decision: 'waiting', reason: `cited by open scope Issue ${issues.join(', ')}` });
      continue;
    }
    if (!entry) {
      unknown.push(id);
      continue;
    }
    runnable.push(entry);
  }

  const all = request.mode === 'all';
  const selectedIds = new Set(ids);
  const runnableCoverage = computeCoverage(runnable, scenarios);
  const gaps: Gap[] = [];
  if (!all) {
    for (const id of unknown) {
      gaps.push({ id, missing: NOT_IN_MAP });
      decisions.push({ subject: id, decision: 'coverage gap: request', reason: NOT_IN_MAP });
    }
    for (const u of runnableCoverage.uncovered) {
      gaps.push({ id: u.id, missing: u.missingPlatforms });
      decisions.push({
        subject: u.id,
        decision: 'coverage gap: request',
        reason: `no scenario on ${u.missingPlatforms.join(', ')}`,
      });
    }
  } else {
    for (const id of unknown) decisions.push({ subject: id, decision: 'listed', reason: NOT_IN_MAP });
  }
  const uncoveredRunnable = new Set(runnableCoverage.uncovered.map((u) => u.id));
  for (const e of runnable) {
    if (!uncoveredRunnable.has(e.id))
      decisions.push({ subject: e.id, decision: 'run', reason: 'selected and has a scenario' });
  }

  const whole = computeCoverage(entries, scenarios);
  const unselectedGaps = whole.uncovered.filter((u) => all || !selectedIds.has(u.id));
  for (const u of unselectedGaps) {
    decisions.push({
      subject: u.id,
      decision: 'listed, not filed',
      reason: `${all ? 'gap in an --all run' : 'not selected'}; no scenario on ${u.missingPlatforms.join(', ')}`,
    });
  }
  const coverage = { passed: whole.covered === whole.total, covered: whole.covered, total: whole.total };
  decisions.push({
    subject: 'coverage check',
    decision: coverage.passed ? 'passed' : 'failed',
    reason: `${coverage.covered}/${coverage.total} rules in coverage-map.json have a scenario on every required platform`,
  });

  const selection: Plan['selection'] = all ? { all: true } : { all: false, rules: runnable.map((e) => e.id) };
  const execute = selection.all || selection.rules.length > 0;
  decisions.push({
    subject: 'execution',
    decision: execute ? 'run' : 'nothing to run',
    reason: selection.all ? '--all' : `rules: ${selection.rules.join(', ') || 'none'}`,
  });

  const plan: Plan = {
    mode: request.mode,
    source,
    selection,
    waiting,
    excluded,
    unknown,
    gaps,
    unselectedGaps,
    coverage,
    execute,
    decisions,
    summary: decisionTable('Gate plan', decisions),
  };
  return { plan };
}
