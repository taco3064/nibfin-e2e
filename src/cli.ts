import { parseArgs } from 'node:util';
import { computeCoverage, crossCheck, loadMap, validateRegistry } from './coverage.ts';
import { provisioning, scenarios } from './registry.ts';
import { detectPlatform, run } from './run.ts';
import { select } from './select.ts';
import type { Selection } from './select.ts';
import type { MapEntry, ProvisioningStep, Scenario } from './types.ts';

export interface CliDeps {
  loadMap(): { entries: MapEntry[]; errors: string[] };
  scenarios: Scenario[];
  steps: ProvisioningStep[];
  nodePlatform: string;
  stdout(text: string): void;
  stderr(text: string): void;
  now?: () => Date;
}

const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE = /^[^\s@]+@(sha256:[0-9a-f]{64})$/;

export const USAGE = `usage: npm run e2e -- <selection> [--list | --uncovered | --gh-nibfin-commit <sha> --image <ref@sha256:digest>]
  selection: --all, or one or more of --rule R<section>.<n> and --section <n> (repeatable, union)
  --list, --uncovered   report without running anything (default selection: --all)`;

/** Runs the CLI and returns the exit code: 0 ok, 1 a scenario or the gate failed, 2 usage or validation error. */
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
        image: { type: 'string' },
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
  if (values.all && hasSelection) usage.push('use either --all or --rule/--section, not both');
  if (values.list && values.uncovered) usage.push('use either --list or --uncovered, not both');
  const commit = values['gh-nibfin-commit'];
  const image = values.image;
  if (report) {
    if (commit !== undefined || image !== undefined) usage.push('--gh-nibfin-commit and --image are only for execution');
  } else {
    if (!values.all && !hasSelection) usage.push('execution needs --all or a --rule/--section selection');
    if (commit === undefined || !COMMIT.test(commit)) usage.push('--gh-nibfin-commit must be a full 40-hex commit sha');
    if (image === undefined || !IMAGE.test(image)) usage.push('--image must be pinned by digest: <ref>@sha256:<64 hex>');
  }
  const platform = detectPlatform(deps.nodePlatform);
  if (!report && !platform) usage.push(`unsupported platform ${deps.nodePlatform}`);
  if (usage.length) return fail('usage', usage);

  const map = deps.loadMap();
  const invalid = [...map.errors, ...validateRegistry(deps.scenarios, deps.steps)];
  if (!invalid.length) invalid.push(...crossCheck(map.entries, deps.scenarios));
  if (invalid.length) return fail('validation', invalid);

  const selection: Selection = hasSelection ? { all: false, rules, sections } : { all: true };
  const { selected, errors } = select(map.entries, deps.scenarios, selection);
  if (errors.length) return fail('usage', errors);
  const selectedRules = selected.entries.filter((e) => !('notE2e' in e)).map((e) => e.id);

  if (values.list) {
    print({
      mode: 'list',
      selection,
      rules: selectedRules,
      excluded: selected.excluded,
      scenarios: selected.scenarios.map(({ id, rules: r, platforms, requires }) => ({ id, rules: r, platforms, requires: requires ?? [] })),
    });
    return 0;
  }
  if (values.uncovered) {
    print({ mode: 'uncovered', selection, coverage: computeCoverage(selected.entries, selected.scenarios) });
    return 0;
  }

  const digest = IMAGE.exec(image as string)?.[1] as string;
  const result = await run({
    selection,
    selected,
    steps: deps.steps,
    target: { ghNibfinCommit: commit as string, image: image as string, imageDigest: digest, platform: platform as NonNullable<typeof platform> },
    log: (m) => deps.stderr(m + '\n'),
    now: deps.now,
  });
  print(result);
  const anyFailed = result.scenarios.some((s) => s.status === 'failed');
  return anyFailed || result.gate?.passed === false ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    loadMap: () => loadMap(new URL('../coverage-map.json', import.meta.url)),
    scenarios,
    steps: provisioning,
    nodePlatform: process.platform,
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  });
}
