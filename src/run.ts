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
  /** The required step whose failure or waiting kept this step from running. */
  blockedBy?: string;
}

export interface TeardownResult extends Outcome {
  id: string;
}

export interface ScenarioResult extends Outcome {
  id: string;
  rules: RuleId[];
  /** The required step whose failure or waiting kept this scenario from running. */
  blockedBy?: string;
}

/** A selected rule that an open `scope` Issue still cites: the Proposal is ahead of the implementation (Proposal R8.20). */
export interface WaitingRule {
  id: RuleId;
  issues: string[];
}

export interface RunResult {
  meta: RunTarget & {
    /** The Nibfin image digest `init` pinned, or null when no step resolved it. */
    imageDigest: string | null;
    /** The runner that executed this run (`RUNNER_NAME`), or null when it is unset. */
    runner: string | null;
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
  /** Bound for each deferred cleanup (default 60 s). */
  cleanupTimeoutMs?: number;
  /** Selected rules that are waiting; a scenario whose selected rules are all waiting is not run. */
  waiting?: WaitingRule[];
  runner?: string | null;
  /**
   * The harness budget in ms from `budgetStart`. Its end is the final limit, where
   * teardown stops and the result is returned. Absent: nothing is bounded.
   */
  budgetMs?: number;
  /** The part of the budget kept for teardown: provisioning and scenarios stop at `budgetMs - teardownReserveMs` (the work limit). */
  teardownReserveMs?: number;
  /** How long work cut off at the work limit may take to settle before its cleanups and teardown run (default 2 min). */
  settleMs?: number;
  /** Epoch ms the budget counts from (default: when `run` starts). */
  budgetStart?: number;
  /** Called when a budget limit cut work or teardown off, so the caller can exit without waiting for it. */
  onLimit?: () => void;
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

/** Runs and clears the deferred cleanups, newest first; a throw or a hang is logged and never changes an outcome. */
async function runCleanups(cleanups: (() => Promise<unknown>)[], owner: string, timeoutMs: number, log: (m: string) => void): Promise<void> {
  while (cleanups.length) {
    const fn = cleanups.pop() as () => Promise<unknown>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<StepOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'failed', reason: `did not finish within ${timeoutMs} ms` }), timeoutMs);
    });
    const out = await Promise.race([attempt(async () => (await fn(), { status: 'passed', reason: '' })), bounded]);
    clearTimeout(timer);
    if (out.status !== 'passed') log(`cleanup of ${owner}: ${out.reason}`);
  }
}

/** A timer that resolves at epoch ms `at`; `clear` stops it. */
function timerAt(at: number): { done: Promise<void>; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, at - Date.now()));
  });
  return { done, clear: () => clearTimeout(timer) };
}

/** `p`'s value, or undefined when epoch ms `at` comes first. */
async function before<T>(p: Promise<T>, at: number): Promise<{ value: T } | undefined> {
  const t = timerAt(at);
  try {
    return await Promise.race([p.then((value) => ({ value })), t.done.then(() => undefined)]);
  } finally {
    t.clear();
  }
}

const minutes = (ms: number) => `${Number((ms / 60_000).toFixed(2))} min`;

const plain = ({ status, reason }: Outcome): Outcome => ({ status, reason });

/** The first required step that did not pass, failed before waiting. */
function blocker(required: string[], results: Map<string, StepResult>): (Outcome & { blockedBy: string }) | undefined {
  const got = required.map((id) => results.get(id)).filter((p) => p !== undefined);
  const failed = got.find((p) => p.status === 'failed');
  if (failed) return { status: 'failed', reason: `provisioning step ${failed.id} failed: ${failed.reason}`, blockedBy: failed.id };
  const waiting = got.find((p) => p.status === 'waiting');
  if (waiting) return { status: 'waiting', reason: `provisioning step ${waiting.id} is waiting: ${waiting.reason}`, blockedBy: waiting.id };
  return undefined;
}

/** Splits scenarios into groups run one after another: each maximal run of consecutive `concurrent` scenarios is one group, every other scenario is a group of its own. */
export function scenarioGroups(list: Scenario[]): Scenario[][] {
  const groups: Scenario[][] = [];
  for (const s of list) {
    const last = groups[groups.length - 1];
    if (s.concurrent && last?.[0]?.concurrent) last.push(s);
    else groups.push([s]);
  }
  return groups;
}

/** Waiting for a scenario whose selected rules are all waiting; undefined when any selected rule can run. */
function waitingFor(s: Scenario, selectedRules: Set<string>, waiting: Map<string, string[]>): Outcome | undefined {
  const mine = s.rules.filter((r) => selectedRules.has(r));
  if (mine.length === 0 || !mine.every((r) => waiting.has(r))) return undefined;
  const parts = mine.map((r) => `rule ${r} is waiting on ${(waiting.get(r) ?? []).join(', ')}`);
  return { status: 'waiting', reason: `not run: ${parts.join('; ')}` };
}

export async function run(input: RunInput): Promise<RunResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { target, selected } = input;
  const results = new Map<string, StepResult>();
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? 60_000;

  // The budget: provisioning and scenarios stop at the work limit, teardown at the final limit.
  const budgetStart = input.budgetStart ?? Date.now();
  const finalAt = input.budgetMs === undefined ? undefined : budgetStart + input.budgetMs;
  const workEndsAt = finalAt === undefined ? undefined : finalAt - (input.teardownReserveMs ?? 0);
  const settleMs = input.settleMs ?? 2 * 60_000;
  const workBudget = minutes((workEndsAt ?? 0) - budgetStart);
  const finalBudget = minutes(input.budgetMs ?? 0);
  const controller = new AbortController();
  let settleBy = 0;
  const pastWork = () => controller.signal.aborted || (workEndsAt !== undefined && Date.now() >= workEndsAt);
  const notRun = (): Outcome => ({ status: 'failed', reason: `not run: harness budget of ${workBudget} ran out` });
  /** Runs work until the work limit. When the limit comes first, the run-wide signal aborts (once) and the work gets until the shared settle time to unwind. */
  const bounded = async (label: string, fn: () => Promise<StepOutcome>, reason: string): Promise<StepOutcome> => {
    const work = attempt(fn);
    if (workEndsAt === undefined) return work;
    const got = await before(work, workEndsAt);
    // Work that ended only because another piece of work's cut-off aborted the signal was cut off too.
    if (got && !controller.signal.aborted) return got.value;
    if (!controller.signal.aborted) {
      input.log(`harness budget of ${workBudget} ran out during ${label}`);
      settleBy = Date.now() + settleMs;
      controller.abort(new Error(`harness budget of ${workBudget} ran out`));
      input.onLimit?.();
    }
    if (!(await before(work, settleBy))) input.log(`${label} did not settle within ${Math.round(settleMs / 1000)} s after the budget ran out`);
    return { status: 'failed', reason };
  };

  /** A context whose deferred cleanups and started children go to `cleanups`; each scenario gets its own, so concurrent ones never run each other's. */
  const contextWith = (cleanups: (() => Promise<unknown>)[], next: () => number, signal: AbortSignal = controller.signal): RunContext => {
    const defer = (fn: () => Promise<unknown>) => void cleanups.push(fn);
    return {
      ...input.host,
      signal,
      target,
      log: input.log,
      facts: (id) => results.get(id)?.facts,
      defer,
      upcoming: () => groups.slice(next()).flat().map((s) => s.id),
      startGhNibfin(args, options) {
        const child = input.host.startGhNibfin(args, options);
        defer(() => child.stop());
        return child;
      },
      start(argv) {
        const child = input.host.start(argv);
        defer(() => child.stop());
        return child;
      },
    };
  };
  const cleanups: (() => Promise<unknown>)[] = [];
  /** The scenario groups, in run order, and the index of the first group not yet started (for steps and teardowns). */
  let groups: Scenario[][] = [];
  let started = 0;
  const ctx = contextWith(cleanups, () => started);

  const onThisPlatform: Scenario[] = selected.scenarios.filter((s) => s.platforms.includes(target.platform));
  const selectedRules = new Set(selected.entries.filter((e) => !isExcluded(e)).map((e) => e.id));
  const waitingRules = new Map((input.waiting ?? []).map((w) => [w.id, w.issues]));
  const waitingScenarios = new Map<string, Outcome>();
  for (const s of onThisPlatform) {
    const w = waitingFor(s, selectedRules, waitingRules);
    if (w) waitingScenarios.set(s.id, w);
  }
  const toRun = onThisPlatform.filter((s) => !waitingScenarios.has(s.id));
  groups = scenarioGroups(toRun);
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
    else if (pastWork()) outcome = notRun();
    else {
      input.log(`provisioning ${step.id}`);
      ran.push(step);
      outcome = await bounded(`step ${step.id}`, () => step.run(ctx), `harness budget of ${workBudget} ran out during this step`);
      await runCleanups(cleanups, `step ${step.id}`, cleanupTimeoutMs, input.log);
    }
    const r = { id: step.id, ...outcome };
    provisioning.push(r);
    results.set(step.id, r);
  }

  const runScenario = async (s: Scenario, next: number): Promise<ScenarioResult> => {
    let outcome: (Outcome & { blockedBy?: string }) | undefined = blocker(s.requires ?? [], results);
    if (!outcome && pastWork()) outcome = notRun();
    if (!outcome) {
      input.log(`scenario ${s.id}`);
      const own: (() => Promise<unknown>)[] = [];
      outcome = plain(await bounded(`scenario ${s.id}`, () => s.run(contextWith(own, () => next)), `harness budget of ${workBudget} ran out during this scenario`));
      await runCleanups(own, `scenario ${s.id}`, cleanupTimeoutMs, input.log);
    }
    return { id: s.id, rules: s.rules, ...outcome };
  };
  const ranResults = new Map<string, ScenarioResult>();
  for (const [i, group] of groups.entries()) {
    started = i + 1;
    // A group of concurrent scenarios starts together.
    for (const r of await Promise.all(group.map((s) => runScenario(s, i + 1)))) ranResults.set(r.id, r);
  }
  started = groups.length;
  // Waiting scenarios are not run; results keep registry order.
  const scenarios: ScenarioResult[] = onThisPlatform.map((s) => {
    const w = waitingScenarios.get(s.id);
    return w ? { id: s.id, rules: s.rules, ...w } : (ranResults.get(s.id) as ScenarioResult);
  });

  // Teardown is not stopped by the work limit's abort: it gets a signal of its own and is bounded only by the final limit.
  const teardown: TeardownResult[] = [];
  const tearCleanups: (() => Promise<unknown>)[] = [];
  const tearCtx = contextWith(tearCleanups, () => started, new AbortController().signal);
  let cut = false;
  for (const step of [...ran].reverse()) {
    const fn = step.teardown;
    if (!fn) continue;
    if (finalAt !== undefined && (cut || Date.now() >= finalAt)) {
      teardown.push({ id: step.id, status: 'failed', reason: `not run: the harness's final limit of ${finalBudget} ran out` });
      continue;
    }
    input.log(`teardown ${step.id}`);
    const work = (async () => {
      const out = plain(await attempt(() => fn.call(step, tearCtx)));
      await runCleanups(tearCleanups, `teardown ${step.id}`, cleanupTimeoutMs, input.log);
      return out;
    })();
    const got = finalAt === undefined ? { value: await work } : await before(work, finalAt);
    if (got) teardown.push({ id: step.id, ...got.value });
    else {
      cut = true;
      input.log(`teardown ${step.id} did not finish before the harness's final limit of ${finalBudget}`);
      input.onLimit?.();
      teardown.push({ id: step.id, status: 'failed', reason: `did not finish before the harness's final limit of ${finalBudget}` });
    }
  }

  const digest = provisioning.map((p) => p.facts?.imageDigest).find((d) => typeof d === 'string');
  const onPlatform = new Set(onThisPlatform.flatMap((s) => s.rules));
  const rulesWithoutScenarioOnPlatform = selected.entries
    .filter((e) => !isExcluded(e) && !onPlatform.has(e.id))
    .map((e) => e.id);
  const coverage = computeCoverage(selected.entries, selected.scenarios);

  const result: RunResult = {
    meta: {
      ...target,
      imageDigest: digest ?? null,
      runner: input.runner ?? null,
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
