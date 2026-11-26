import { computeCoverage } from './coverage.ts';
import type { Coverage } from './coverage.ts';
import type { Selected, Selection } from './select.ts';
import { STATUSES, isExcluded } from './types.ts';
import type { Outcome, Platform, ProvisioningStep, RunContext, RunTarget, RuleId, Scenario } from './types.ts';

export function detectPlatform(nodePlatform: string): Platform | undefined {
  const map = new Map<string, Platform>([['linux', 'linux'], ['darwin', 'macos'], ['win32', 'windows']]);
  return map.get(nodePlatform);
}

export interface StepResult extends Outcome {
  id: string;
}

export interface ScenarioResult extends Outcome {
  id: string;
  rules: RuleId[];
}

export interface RunResult {
  meta: RunTarget & {
    mode: 'select' | 'all';
    selection: Selection;
    startedAt: string;
    finishedAt: string;
  };
  provisioning: StepResult[];
  scenarios: ScenarioResult[];
  /** Selected non-excluded rules that no selected scenario runs on this platform. */
  rulesWithoutScenarioOnPlatform: RuleId[];
  coverage: Coverage;
  gate?: { passed: boolean; reasons: string[] };
}

export interface RunInput {
  selection: Selection;
  selected: Selected;
  steps: ProvisioningStep[];
  target: RunTarget;
  log(message: string): void;
  now?: () => Date;
}

/** Runs one step or scenario; a throw or a malformed outcome becomes `failed`. */
async function attempt(fn: () => Promise<Outcome>): Promise<Outcome> {
  try {
    const out: unknown = await fn();
    const o = out as Partial<Outcome> | null;
    if (o && (STATUSES as readonly unknown[]).includes(o.status) && typeof o.reason === 'string') {
      return { status: o.status as Outcome['status'], reason: o.reason };
    }
    return { status: 'failed', reason: `invalid outcome: ${JSON.stringify(out)}` };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function run(input: RunInput): Promise<RunResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { target, selected } = input;
  const ctx: RunContext = { target, log: input.log };

  const toRun: Scenario[] = selected.scenarios.filter((s) => s.platforms.includes(target.platform));
  const needed = new Set(toRun.flatMap((s) => s.requires ?? []));

  const provisioning: StepResult[] = [];
  for (const step of input.steps) {
    if (!needed.has(step.id)) continue;
    input.log(`provisioning ${step.id}`);
    provisioning.push({ id: step.id, ...(await attempt(() => step.run(ctx))) });
  }
  const stepById = new Map(provisioning.map((p) => [p.id, p]));

  const scenarios: ScenarioResult[] = [];
  for (const s of toRun) {
    const required = (s.requires ?? []).map((id) => stepById.get(id)).filter((p) => p !== undefined);
    const failed = required.find((p) => p.status === 'failed');
    const waiting = required.find((p) => p.status === 'waiting');
    let outcome: Outcome;
    if (failed) outcome = { status: 'failed', reason: `provisioning step ${failed.id} failed: ${failed.reason}` };
    else if (waiting) outcome = { status: 'waiting', reason: `provisioning step ${waiting.id} is waiting: ${waiting.reason}` };
    else {
      input.log(`scenario ${s.id}`);
      outcome = await attempt(() => s.run(ctx));
    }
    scenarios.push({ id: s.id, rules: s.rules, ...outcome });
  }

  const onPlatform = new Set(toRun.flatMap((s) => s.rules));
  const rulesWithoutScenarioOnPlatform = selected.entries
    .filter((e) => !isExcluded(e) && !onPlatform.has(e.id))
    .map((e) => e.id);
  const coverage = computeCoverage(selected.entries, selected.scenarios);

  const result: RunResult = {
    meta: {
      ...target,
      mode: input.selection.all ? 'all' : 'select',
      selection: input.selection,
      startedAt,
      finishedAt: '',
    },
    provisioning,
    scenarios,
    rulesWithoutScenarioOnPlatform,
    coverage,
  };
  if (input.selection.all) {
    const reasons: string[] = [];
    if (coverage.covered < coverage.total) {
      reasons.push(`coverage is ${coverage.percent}% (${coverage.covered}/${coverage.total}); a release needs 100%`);
    }
    for (const s of scenarios) if (s.status !== 'passed') reasons.push(`scenario ${s.id} ${s.status}: ${s.reason}`);
    result.gate = { passed: reasons.length === 0, reasons };
  }
  result.meta.finishedAt = now().toISOString();
  return result;
}
