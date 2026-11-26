import { computeCoverage } from './coverage.ts';
import type { Coverage } from './coverage.ts';
import type { Selected, Selection } from './select.ts';
import { STATUSES, isExcluded } from './types.ts';
import type { HostContext, Outcome, Platform, ProvisioningStep, RunContext, RunTarget, RuleId, Scenario, StepOutcome } from './types.ts';

export function detectPlatform(nodePlatform: string): Platform | undefined {
  const map = new Map<string, Platform>([['linux', 'linux'], ['darwin', 'macos'], ['win32', 'windows']]);
  return map.get(nodePlatform);
}

export interface StepResult extends StepOutcome {
  id: string;
}

export interface TeardownResult extends Outcome {
  id: string;
}

export interface ScenarioResult extends Outcome {
  id: string;
  rules: RuleId[];
}

export interface RunResult {
  meta: RunTarget & {
    /** The Nibfin image digest `init` pinned, or null when no step resolved it. */
    imageDigest: string | null;
    mode: 'select' | 'all';
    selection: Selection;
    startedAt: string;
    finishedAt: string;
  };
  provisioning: StepResult[];
  scenarios: ScenarioResult[];
  teardown: TeardownResult[];
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
  host: HostContext;
  log(message: string): void;
  now?: () => Date;
}

/** Runs one step, teardown or scenario; a throw or a malformed outcome becomes `failed`. */
async function attempt(fn: () => Promise<StepOutcome>): Promise<StepOutcome> {
  try {
    const out: unknown = await fn();
    const o = out as Partial<StepOutcome> | null;
    if (o && (STATUSES as readonly unknown[]).includes(o.status) && typeof o.reason === 'string') {
      const facts = typeof o.facts === 'object' && o.facts !== null ? { facts: o.facts } : {};
      return { status: o.status as Outcome['status'], reason: o.reason, ...facts };
    }
    return { status: 'failed', reason: `invalid outcome: ${JSON.stringify(out)}` };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

const plain = ({ status, reason }: Outcome): Outcome => ({ status, reason });

/** The first required step that did not pass, failed before waiting. */
function blocker(required: string[], results: Map<string, StepResult>): Outcome | undefined {
  const got = required.map((id) => results.get(id)).filter((p) => p !== undefined);
  const failed = got.find((p) => p.status === 'failed');
  if (failed) return { status: 'failed', reason: `provisioning step ${failed.id} failed: ${failed.reason}` };
  const waiting = got.find((p) => p.status === 'waiting');
  if (waiting) return { status: 'waiting', reason: `provisioning step ${waiting.id} is waiting: ${waiting.reason}` };
  return undefined;
}

export async function run(input: RunInput): Promise<RunResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { target, selected } = input;
  const results = new Map<string, StepResult>();
  const ctx: RunContext = { ...input.host, target, log: input.log, facts: (id) => results.get(id)?.facts };

  const toRun: Scenario[] = selected.scenarios.filter((s) => s.platforms.includes(target.platform));
  const byId = new Map(input.steps.map((s) => [s.id, s]));
  const needed = new Set<string>();
  const need = (id: string) => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const r of byId.get(id)?.requires ?? []) need(r);
  };
  for (const s of toRun) for (const id of s.requires ?? []) need(id);

  const provisioning: StepResult[] = [];
  const ran: ProvisioningStep[] = [];
  for (const step of input.steps) {
    if (!needed.has(step.id)) continue;
    const blocked = blocker(step.requires ?? [], results);
    let outcome: StepOutcome;
    if (blocked) outcome = blocked;
    else {
      input.log(`provisioning ${step.id}`);
      ran.push(step);
      outcome = await attempt(() => step.run(ctx));
    }
    const r = { id: step.id, ...outcome };
    provisioning.push(r);
    results.set(step.id, r);
  }

  const scenarios: ScenarioResult[] = [];
  for (const s of toRun) {
    let outcome = blocker(s.requires ?? [], results);
    if (!outcome) {
      input.log(`scenario ${s.id}`);
      outcome = plain(await attempt(() => s.run(ctx)));
    }
    scenarios.push({ id: s.id, rules: s.rules, ...outcome });
  }

  const teardown: TeardownResult[] = [];
  for (const step of [...ran].reverse()) {
    const fn = step.teardown;
    if (!fn) continue;
    input.log(`teardown ${step.id}`);
    teardown.push({ id: step.id, ...plain(await attempt(() => fn.call(step, ctx))) });
  }

  const digest = provisioning.map((p) => p.facts?.imageDigest).find((d) => typeof d === 'string');
  const onPlatform = new Set(toRun.flatMap((s) => s.rules));
  const rulesWithoutScenarioOnPlatform = selected.entries
    .filter((e) => !isExcluded(e) && !onPlatform.has(e.id))
    .map((e) => e.id);
  const coverage = computeCoverage(selected.entries, selected.scenarios);

  const result: RunResult = {
    meta: {
      ...target,
      imageDigest: digest ?? null,
      mode: input.selection.all ? 'all' : 'select',
      selection: input.selection,
      startedAt,
      finishedAt: '',
    },
    provisioning,
    scenarios,
    teardown,
    rulesWithoutScenarioOnPlatform,
    coverage,
  };
  if (input.selection.all) {
    const reasons: string[] = [];
    if (coverage.covered < coverage.total) {
      reasons.push(`coverage is ${coverage.percent}% (${coverage.covered}/${coverage.total}); a release needs 100%`);
    }
    for (const s of scenarios) if (s.status !== 'passed') reasons.push(`scenario ${s.id} ${s.status}: ${s.reason}`);
    for (const t of teardown) if (t.status !== 'passed') reasons.push(`teardown ${t.id} ${t.status}: ${t.reason}`);
    result.gate = { passed: reasons.length === 0, reasons };
  }
  result.meta.finishedAt = now().toISOString();
  return result;
}
