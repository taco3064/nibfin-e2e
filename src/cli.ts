import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { computeCoverage, crossCheck, loadMap, validateRegistry } from './coverage.ts';
import { host, provisioning, scenarios } from './registry.ts';
import { detectPlatform, run } from './run.ts';
import type { WaitingRule } from './run.ts';
import { select } from './select.ts';
import type { Selection } from './select.ts';
import type { HostContext, MapEntry, ProvisioningStep, Scenario } from './types.ts';

export interface CliDeps {
  loadMap(): { entries: MapEntry[]; errors: string[] };
  scenarios: Scenario[];
  steps: ProvisioningStep[];
  host: HostContext;
  nodePlatform: string;
  stdout(text: string): void;
  stderr(text: string): void;
  now?: () => Date;
  /** `RUNNER_NAME`, recorded as `meta.runner`. */
  runner?: string | null;
  /** Reads the `--plan` file. */
  readFile?: (path: string) => string;
  /** Epoch ms the harness started; the budget counts from it (default: when `main` starts). */
  startedAt?: number;
  /**
   * Called with the exit code after the result was written when a budget limit cut work
   * off, so work that never settled cannot keep the process alive past the job timeout.
   */
  exit?: (code: number) => void;
  /** Overrides the budget's teardown reserve and settle time (tests). */
  budget?: { teardownReserveMs?: number; settleMs?: number };
}

/** The harness budget when `--budget-minutes` is absent: 20 min below the 240-min job timeout of `e2e.yml`. */
export const DEFAULT_BUDGET_MINUTES = 220;
/** The part of the budget kept for teardown; provisioning and scenarios stop before it. */
export const TEARDOWN_RESERVE_MINUTES = 30;
/** How long work cut off at the work limit may take to unwind before teardown. */
export const SETTLE_MS = 2 * 60_000;

const COMMIT = /^[0-9a-f]{40}$/;

export const USAGE = `usage: npm run e2e -- <selection> [--list | --uncovered | --gh-nibfin-commit <sha> [--budget-minutes <n>]]
  selection: --all, or one or more of --rule R<section>.<n> and --section <n> (repeatable, union),
             or --plan <path> (the gate's plan: its selection and waiting rules)
  --list, --uncovered   report without running anything (default selection: --all)
  --budget-minutes <n>  the harness's final limit from its start (default ${DEFAULT_BUDGET_MINUTES}): provisioning and
                        scenarios stop ${TEARDOWN_RESERVE_MINUTES} min before it, teardown at it, and the result is written`;

/** Runs the CLI and returns the exit code: 0 ok, 1 a scenario, a teardown or the gate failed, 2 usage or validation error. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const print = (doc: unknown) => deps.stdout(JSON.stringify(doc, null, 2) + '\n');
  const fail = (kind: 'usage' | 'validation', messages: string[]) => {
    for (const m of messages) deps.stderr(`${kind} error: ${m}\n`);
    if (kind === 'usage') deps.stderr(USAGE + '\n');
    print({ error: { kind, messages } });
    return 2;
  };

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        rule: { type: 'string', multiple: true },
        section: { type: 'string', multiple: true },
        all: { type: 'boolean' },
        list: { type: 'boolean' },
        uncovered: { type: 'boolean' },
        'gh-nibfin-commit': { type: 'string' },
        plan: { type: 'string' },
        'budget-minutes': { type: 'string' },
      },
    }));
  } catch (error) {
    return fail('usage', [(error as Error).message]);
  }

  const rules = values.rule ?? [];
  const sections = values.section ?? [];
  const hasSelection = rules.length + sections.length > 0;
  const report = values.list || values.uncovered;
  const usage: string[] = [];
  const planPath = values.plan;
  if (values.all && hasSelection) usage.push('use either --all or --rule/--section, not both');
  if (planPath !== undefined && (values.all || hasSelection))
    usage.push('use either --plan or --all/--rule/--section, not both');
  if (values.list && values.uncovered) usage.push('use either --list or --uncovered, not both');
  const commit = values['gh-nibfin-commit'];
  const budgetArg = values['budget-minutes'];
  const budgetMinutes =
    budgetArg === undefined ? DEFAULT_BUDGET_MINUTES : /^\d+$/.test(budgetArg) ? Number(budgetArg) : NaN;
  if (report) {
    if (commit !== undefined) usage.push('--gh-nibfin-commit is only for execution');
    if (budgetArg !== undefined) usage.push('--budget-minutes is only for execution');
  } else {
    if (!(budgetMinutes > TEARDOWN_RESERVE_MINUTES))
      usage.push(`--budget-minutes must be an integer above the teardown reserve of ${TEARDOWN_RESERVE_MINUTES}`);
    if (!values.all && !hasSelection && planPath === undefined)
      usage.push('execution needs --all or a --rule/--section selection');
    if (commit === undefined || !COMMIT.test(commit)) usage.push('--gh-nibfin-commit must be a full 40-hex commit sha');
  }
  const platform = detectPlatform(deps.nodePlatform);
  if (!report && !platform) usage.push(`unsupported platform ${deps.nodePlatform}`);
  if (usage.length) return fail('usage', usage);

  const map = deps.loadMap();
  const invalid = [...map.errors, ...validateRegistry(deps.scenarios, deps.steps)];
  if (!invalid.length) invalid.push(...crossCheck(map.entries, deps.scenarios));
  if (invalid.length) return fail('validation', invalid);

  let selection: Selection = hasSelection ? { all: false, rules, sections } : { all: true };
  let waiting: WaitingRule[] = [];
  if (planPath !== undefined) {
    const plan = readPlan(planPath, deps.readFile ?? ((path) => readFileSync(path, 'utf8')));
    if ('error' in plan) return fail('usage', [plan.error]);
    ({ selection, waiting } = plan);
  }
  const { selected, errors } = select(map.entries, deps.scenarios, selection);
  if (errors.length) return fail('usage', errors);
  const selectedRules = selected.entries.filter((e) => !('notE2e' in e)).map((e) => e.id);

  if (values.list) {
    print({
      mode: 'list',
      selection,
      rules: selectedRules,
      excluded: selected.excluded,
      scenarios: selected.scenarios.map(({ id, rules: r, platforms, requires }) => ({
        id,
        rules: r,
        platforms,
        requires: requires ?? [],
      })),
    });
    return 0;
  }
  if (values.uncovered) {
    print({ mode: 'uncovered', selection, coverage: computeCoverage(selected.entries, selected.scenarios) });
    return 0;
  }

  const startedAt = deps.startedAt ?? Date.now();
  let limitHit = false;
  const result = await run({
    selection,
    selected,
    steps: deps.steps,
    target: { ghNibfinCommit: commit as string, platform: platform as NonNullable<typeof platform> },
    host: deps.host,
    log: (m) => deps.stderr(m + '\n'),
    now: deps.now,
    waiting,
    runner: deps.runner ?? null,
    budgetMs: budgetMinutes * 60_000,
    teardownReserveMs: deps.budget?.teardownReserveMs ?? TEARDOWN_RESERVE_MINUTES * 60_000,
    settleMs: deps.budget?.settleMs ?? SETTLE_MS,
    budgetStart: startedAt,
    onLimit: () => (limitHit = true),
  });
  print(result);
  const anyFailed = [...result.scenarios, ...result.teardown].some((s) => s.status === 'failed');
  const code = anyFailed || result.gate?.passed === false ? 1 : 0;
  if (limitHit) deps.exit?.(code);
  return code;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Reads the selection and the waiting rules from the gate's plan; the selection is still validated by `select()`. */
export function readPlan(
  path: string,
  readFile: (path: string) => string,
): { selection: Selection; waiting: WaitingRule[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(path));
  } catch (error) {
    return { error: `--plan ${path}: cannot read: ${(error as Error).message}` };
  }
  const plan = raw as { selection?: { all?: unknown; rules?: unknown }; waiting?: unknown } | null;
  const sel = plan?.selection;
  let selection: Selection;
  if (sel?.all === true) selection = { all: true };
  else if (sel?.all === false && isStringArray(sel.rules)) selection = { all: false, rules: sel.rules, sections: [] };
  else return { error: `--plan ${path}: selection must be {"all":true} or {"all":false,"rules":[…]}` };
  const w = plan?.waiting;
  if (!Array.isArray(w) || !w.every((x) => typeof x?.id === 'string' && isStringArray(x?.issues))) {
    return { error: `--plan ${path}: waiting must be a list of {"id","issues":[…]}` };
  }
  return { selection, waiting: w.map((x: WaitingRule) => ({ id: x.id, issues: x.issues })) };
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    loadMap: () => loadMap(new URL('../coverage-map.json', import.meta.url)),
    scenarios,
    steps: provisioning,
    host,
    nodePlatform: process.platform,
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    runner: process.env.RUNNER_NAME || null,
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
    // Flush the result first, then exit even if cut-off work still holds the event loop.
    exit: (code) => void process.stdout.write('', () => process.exit(code)),
  });
}
