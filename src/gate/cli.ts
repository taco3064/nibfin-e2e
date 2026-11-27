import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crossCheck, loadMap, validateRegistry } from '../coverage.ts';
import { E2E_REPO, requireEnv } from '../host/config.ts';
import type { Env } from '../host/exec.ts';
import { createGitHub } from '../host/github.ts';
import type { GitHub } from '../host/github.ts';
import { select } from '../select.ts';
import type { MapEntry, ProvisioningStep, Scenario } from '../types.ts';
import type { SourceFile } from './changes.ts';
import { parseIssueRef } from './impact.ts';
import { makePlan } from './plan.ts';
import type { PlanRequest } from './plan.ts';
import { parseProposalEvent, proposalUpdated } from './proposal.ts';
import { report } from './report.ts';
import type { ResultFile, RunEnv } from './report.ts';

export interface GateDeps {
  env: Env;
  /** The client for the Owner's `NIBFIN_GITHUB_TOKEN`; created only after the input is valid. */
  github(token: () => string): GitHub;
  loadMap(): { entries: MapEntry[]; errors: string[] };
  scenarios: Scenario[];
  steps: ProvisioningStep[];
  readFile(path: string): string;
  /** Every `*.json` file under a directory, recursively. */
  readResults(dir: string): ResultFile[];
  /** The checkout's `scenarios/**` `*.ts` files, by repository path; read only for a nibfin-e2e Issue's changed scenarios. */
  sources(): SourceFile[];
  stdout(text: string): void;
  stderr(text: string): void;
}

export const USAGE = `usage: npm run gate -- <subcommand>
  select (--delivered <owner/repo>#<n> | --rule R<s>.<n> ... --section <n> ... | --all)
  report [--plan <path>] --results <dir>
  proposal-updated`;

/** Runs one gate subcommand: 0 ok, 1 a failure, a failed write or read-back or a failed coverage check, 2 usage or input error. */
export async function main(argv: string[], deps: GateDeps): Promise<number> {
  const print = (doc: unknown) => deps.stdout(JSON.stringify(doc, null, 2) + '\n');
  const fail = (kind: 'usage' | 'validation' | 'github', messages: string[], code = 2) => {
    for (const m of messages) deps.stderr(`${kind} error: ${m}\n`);
    if (kind === 'usage') deps.stderr(USAGE + '\n');
    print({ error: { kind, messages } });
    return code;
  };
  const [sub, ...rest] = argv;
  const options = {
    select: { delivered: { type: 'string' }, rule: { type: 'string', multiple: true }, section: { type: 'string', multiple: true }, all: { type: 'boolean' } },
    report: { plan: { type: 'string' }, results: { type: 'string' } },
    'proposal-updated': {},
  } as const;
  if (sub !== 'select' && sub !== 'report' && sub !== 'proposal-updated') return fail('usage', [`unknown subcommand ${JSON.stringify(sub ?? '')}`]);
  let values: Record<string, string | string[] | boolean | undefined>;
  try {
    values = parseArgs({ args: rest, strict: true, allowPositionals: false, options: options[sub] as NonNullable<Parameters<typeof parseArgs>[0]>['options'] }).values as typeof values;
  } catch (error) {
    return fail('usage', [(error as Error).message]);
  }

  const map = deps.loadMap();
  const invalid = [...map.errors, ...validateRegistry(deps.scenarios, deps.steps)];
  if (!invalid.length) invalid.push(...crossCheck(map.entries, deps.scenarios));
  if (invalid.length) return fail('validation', invalid);

  const usage: string[] = [];
  let token: string | undefined;
  try {
    token = requireEnv(deps.env, 'NIBFIN_GITHUB_TOKEN');
  } catch (error) {
    usage.push((error as Error).message);
  }
  const gh = () => deps.github(() => requireEnv(deps.env, 'NIBFIN_GITHUB_TOKEN'));

  if (sub === 'select') {
    const rules = (values.rule as string[] | undefined) ?? [];
    const sections = (values.section as string[] | undefined) ?? [];
    const delivered = values.delivered as string | undefined;
    const modes = [delivered !== undefined, values.all === true, rules.length + sections.length > 0].filter(Boolean).length;
    let request: PlanRequest | undefined;
    if (modes !== 1) usage.push('select needs exactly one of --delivered, --all or a --rule/--section selection');
    else if (delivered !== undefined) {
      const ref = parseIssueRef(delivered);
      if ('error' in ref) usage.push(ref.error);
      else request = { mode: 'delivered', ref };
    } else if (values.all) request = { mode: 'all' };
    else {
      request = { mode: 'select', rules, sections };
      usage.push(...select(map.entries, deps.scenarios, { all: false, rules, sections }).errors);
    }
    if (usage.length || !request || token === undefined) return fail('usage', usage);
    try {
      const out = await makePlan(gh(), map.entries, deps.scenarios, request, () => deps.sources());
      if ('usage' in out) return fail('usage', out.usage);
      print(out.plan);
      return 0;
    } catch (error) {
      return fail('github', [(error as Error).message], 1);
    }
  }

  const runEnv = readRunEnv(deps.env, usage);
  if (sub === 'report') {
    const resultsDir = values.results as string | undefined;
    if (resultsDir === undefined) usage.push('report needs --results <dir>');
    if (usage.length || !runEnv || resultsDir === undefined) return fail('usage', usage);
    const planPath = values.plan as string | undefined;
    let plan: { text: string } | { error: string };
    if (planPath === undefined) plan = { error: 'no --plan given' };
    else {
      try {
        plan = { text: deps.readFile(planPath) };
      } catch (error) {
        plan = { error: `cannot read ${planPath}: ${(error as Error).message}` };
      }
    }
    try {
      const { output, failed } = await report({
        gh: gh(),
        env: runEnv,
        plan,
        results: deps.readResults(resultsDir),
        registry: { entries: map.entries, scenarios: deps.scenarios, steps: deps.steps },
      });
      print(output);
      return failed ? 1 : 0;
    } catch (error) {
      return fail('github', [(error as Error).message], 1);
    }
  }

  const eventPath = deps.env.GITHUB_EVENT_PATH;
  let event: ReturnType<typeof parseProposalEvent> | undefined;
  if (!eventPath) usage.push('missing environment variable GITHUB_EVENT_PATH');
  else {
    try {
      event = parseProposalEvent(deps.readFile(eventPath));
    } catch (error) {
      event = { error: `cannot read GITHUB_EVENT_PATH: ${(error as Error).message}` };
    }
    if ('error' in event) usage.push(event.error);
  }
  if (usage.length || !runEnv || !event || 'error' in event) return fail('usage', usage);
  try {
    const { output, failed } = await proposalUpdated(gh(), runEnv, event);
    print(output);
    return failed ? 1 : 0;
  } catch (error) {
    return fail('github', [(error as Error).message], 1);
  }
}

function readRunEnv(env: Env, usage: string[]): RunEnv | undefined {
  const runId = env.GITHUB_RUN_ID;
  const serverUrl = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  if (!runId || !/^[1-9]\d*$/.test(runId)) usage.push('GITHUB_RUN_ID must be a run id');
  if (!serverUrl || !/^https:\/\/[^\s/]+$/.test(serverUrl)) usage.push('GITHUB_SERVER_URL must be an https origin');
  if (repository !== E2E_REPO) usage.push(`GITHUB_REPOSITORY must be ${E2E_REPO}`);
  if (!runId || !serverUrl || repository !== E2E_REPO || usage.length) return undefined;
  return { runId, serverUrl, repository };
}

/** Every `*.json` under `dir`, recursively; an unreadable directory or file is reported, not thrown. */
export function readResultFiles(dir: string): ResultFile[] {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' });
  } catch (error) {
    return [{ path: dir, error: `cannot read the results directory: ${(error as Error).message}` }];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => {
      const path = relative('.', join(dir, n)) || n;
      try {
        return { path, text: readFileSync(join(dir, n), 'utf8') };
      } catch (error) {
        return { path, error: (error as Error).message };
      }
    });
}

/** Every `*.ts` under `<root>/scenarios/`, with paths relative to `root` and `/` separators. */
export function readScenarioSources(root: string): SourceFile[] {
  const dir = join(root, 'scenarios');
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((n) => n.endsWith('.ts'))
    .sort()
    .map((n) => ({ path: relative(root, join(dir, n)).split(sep).join('/'), text: readFileSync(join(dir, n), 'utf8') }));
}

if (import.meta.main) {
  const { scenarios, provisioning } = await import('../registry.ts');
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    github: (token) => createGitHub(token),
    loadMap: () => loadMap(new URL('../../coverage-map.json', import.meta.url)),
    scenarios,
    steps: provisioning,
    readFile: (path) => readFileSync(path, 'utf8'),
    readResults: readResultFiles,
    sources: () => readScenarioSources(fileURLToPath(new URL('../..', import.meta.url))),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  });
}
