import { E2E_REPO } from '../host/config.ts';
import type { GitHub } from '../host/github.ts';
import { PLATFORMS, STATUSES } from '../types.ts';
import type { MapEntry, Platform, ProvisioningStep, RuleId, Scenario, Status } from '../types.ts';
import { decisionTable } from './decisions.ts';
import type { Decision } from './decisions.ts';
import { cap, fence, fileSubject, filingContext, MAX_BODY } from './file.ts';
import type { Filed, Subject } from './file.ts';
import { NOT_IN_MAP } from './plan.ts';
import type { Gap } from './plan.ts';

export interface RunEnv {
  runId: string;
  serverUrl: string;
  repository: string;
}

/** A result file's contents, or why it could not be read. */
export interface ResultFile {
  path: string;
  text?: string;
  error?: string;
}

interface Entry {
  id: string;
  status: Status;
  reason: string;
  blockedBy?: string;
  rules?: RuleId[];
}

/** A harness result that passed validation against the registry and the map. */
export interface UsableResult {
  path: string;
  platform: Platform;
  runner: string | null;
  provisioning: Entry[];
  scenarios: (Entry & { rules: RuleId[] })[];
  teardown: Entry[];
}

export interface Registry {
  entries: MapEntry[];
  scenarios: Scenario[];
  steps: ProvisioningStep[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Result files come from hosts where agents ran, so they are untrusted data: a file is used
 * only when its scenario and step ids exist in the registry and its rule ids in the map.
 */
export function validateResult(path: string, text: string, registry: Registry): UsableResult | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `not JSON: ${(error as Error).message}` };
  }
  if (!isObject(raw)) return { error: 'not a result object' };
  if ('error' in raw) return { error: 'the harness reported a usage or validation error instead of a result' };
  const meta = raw.meta;
  if (!isObject(meta) || !(PLATFORMS as readonly unknown[]).includes(meta.platform)) return { error: 'meta.platform is missing or unknown' };
  if (meta.runner !== undefined && meta.runner !== null && typeof meta.runner !== 'string') return { error: 'meta.runner must be a string or null' };
  const stepIds = new Set(registry.steps.map((s) => s.id));
  const scenarioIds = new Set(registry.scenarios.map((s) => s.id));
  const ruleIds = new Set(registry.entries.map((e) => e.id));

  const entries = (key: string, ids: Set<string>, withRules: boolean): Entry[] | string => {
    const list = raw[key];
    if (!Array.isArray(list)) return `${key} must be a list`;
    const out: Entry[] = [];
    for (const [i, item] of list.entries()) {
      const at = `${key}[${i}]`;
      if (!isObject(item)) return `${at} must be an object`;
      if (typeof item.id !== 'string' || !ids.has(item.id)) return `${at}: id ${JSON.stringify(item.id)} is not in the registry`;
      if (!(STATUSES as readonly unknown[]).includes(item.status)) return `${at}: unknown status`;
      if (typeof item.reason !== 'string') return `${at}: reason must be a string`;
      if (item.blockedBy !== undefined && (typeof item.blockedBy !== 'string' || !stepIds.has(item.blockedBy))) return `${at}: blockedBy is not a provisioning step`;
      const e: Entry = { id: item.id, status: item.status as Status, reason: item.reason };
      if (item.blockedBy !== undefined) e.blockedBy = item.blockedBy as string;
      if (withRules) {
        const rules = item.rules;
        if (!Array.isArray(rules) || !rules.every((r) => typeof r === 'string' && ruleIds.has(r))) return `${at}: rules must be coverage map ids`;
        e.rules = rules as RuleId[];
      }
      out.push(e);
    }
    return out;
  };
  const provisioning = entries('provisioning', stepIds, false);
  if (typeof provisioning === 'string') return { error: provisioning };
  const scenarios = entries('scenarios', scenarioIds, true);
  if (typeof scenarios === 'string') return { error: scenarios };
  const teardown = entries('teardown', stepIds, false);
  if (typeof teardown === 'string') return { error: teardown };
  return {
    path,
    platform: meta.platform as Platform,
    runner: typeof meta.runner === 'string' ? meta.runner : null,
    provisioning,
    scenarios: scenarios as UsableResult['scenarios'],
    teardown,
  };
}

/** The rules of the scenarios a step blocked, directly or through other steps. */
function rulesBlockedBy(result: UsableResult, stepId: string): RuleId[] {
  const blocked = new Set([stepId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of result.provisioning) {
      if (p.blockedBy && blocked.has(p.blockedBy) && !blocked.has(p.id)) {
        blocked.add(p.id);
        grew = true;
      }
    }
  }
  return [...new Set(result.scenarios.filter((s) => s.blockedBy && blocked.has(s.blockedBy)).flatMap((s) => s.rules))];
}

interface Job {
  name?: string;
  status?: string;
  conclusion?: string | null;
  runner_name?: string | null;
  html_url?: string;
  steps?: { name?: string; conclusion?: string | null }[];
}

interface Occurrence {
  platform: Platform;
  runner: string | null;
  job: string | null;
  reason: string;
  rules: RuleId[];
}

/**
 * Report's view of the plan: only what filing and the coverage check need, plus the selection,
 * which decides whether the whole-map coverage check can fail the run (only for `--all`, R8.16).
 */
export interface PlanView {
  selection: { all: boolean };
  gaps: Gap[];
  unselectedGaps: { id: RuleId; missingPlatforms: Platform[] }[];
  coverage: { passed: boolean; covered: number; total: number };
  source: { issue?: string; url?: string } | null;
}

const RULE = /^R(0|[1-9]\d*)\.[1-9]\d*$/;

export function readPlanView(text: string): PlanView | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `not JSON: ${(error as Error).message}` };
  }
  if (!isObject(raw)) return { error: 'not a plan object' };
  const { selection, gaps, unselectedGaps, coverage, source } = raw;
  if (!isObject(selection) || typeof selection.all !== 'boolean') return { error: 'selection must be {all, ...}' };
  const platforms = (v: unknown) => Array.isArray(v) && v.every((p) => (PLATFORMS as readonly unknown[]).includes(p));
  if (!Array.isArray(gaps) || !gaps.every((g) => isObject(g) && typeof g.id === 'string' && RULE.test(g.id) && (g.missing === NOT_IN_MAP || platforms(g.missing)))) {
    return { error: 'gaps must be a list of {id, missing}' };
  }
  if (!Array.isArray(unselectedGaps) || !unselectedGaps.every((g) => isObject(g) && typeof g.id === 'string' && RULE.test(g.id) && platforms(g.missingPlatforms))) {
    return { error: 'unselectedGaps must be a list of {id, missingPlatforms}' };
  }
  if (!isObject(coverage) || typeof coverage.passed !== 'boolean' || typeof coverage.covered !== 'number' || typeof coverage.total !== 'number') {
    return { error: 'coverage must be {passed, covered, total}' };
  }
  const src = isObject(source) ? { issue: typeof source.issue === 'string' ? source.issue : undefined, url: typeof source.url === 'string' ? source.url : undefined } : null;
  return { selection: { all: selection.all }, gaps: gaps as Gap[], unselectedGaps: unselectedGaps as PlanView['unselectedGaps'], coverage: coverage as PlanView['coverage'], source: src };
}

const FOOTER =
  'The gate files this without classifying the failure, choosing the owning repository or deciding whether it is transient; the Scope stage judges it (Proposal R3.2, R8.20).';

function occurrencesBody(intro: string, occurrences: Occurrence[]): string {
  const parts = [intro, ''];
  let omitted = 0;
  occurrences.forEach((o, i) => {
    const section = [
      `### ${i + 1}. ${o.platform}${o.runner ? `, runner \`${o.runner.replace(/`/g, "'")}\`` : ''}`,
      '',
      `- Job: ${o.job ?? 'not found in this run'}`,
      `- Related rules: ${o.rules.length ? o.rules.join(', ') : 'none recorded'}`,
      '- Actual result:',
      '',
      fence(cap(o.reason)),
      '',
    ].join('\n');
    if (parts.join('\n').length + section.length > MAX_BODY - 2000) omitted++;
    else parts.push(section);
  });
  if (omitted) parts.push(`${omitted} more occurrences are omitted to keep this Issue under GitHub's size limit; see the run.`, '');
  parts.push(FOOTER);
  return parts.join('\n');
}

export interface ReportOutput {
  decisions: Decision[];
  filed: Filed[];
  coverage: PlanView['coverage'] | null;
  summary: string;
}

export interface ReportInput {
  gh: GitHub;
  env: RunEnv;
  plan: { text: string } | { error: string };
  results: ResultFile[];
  registry: Registry;
  /**
   * Leg mode: the final step of one `run` leg, on the runner `RUNNER_NAME` names. It files that
   * leg's own failures (or `Job failed` for its own job when it has no usable result) and leaves
   * other jobs, plan gaps and the coverage check to the final report; the plan is not read.
   */
  leg?: { runner: string };
}

/** Title and body of a `Job failed` request; both modes build it here, so they file the same title. */
function jobFailed(job: Job, runLine: string, ended: string, stepsLabel: string, steps: string[]): Subject {
  const name = cap(job.name ?? 'unnamed job', 200).replace(/\s+/g, ' ');
  const body = [
    runLine,
    '',
    ended,
    '',
    `- Job: ${job.html_url ?? 'no link'}`,
    `- Runner: ${job.runner_name ? `\`${job.runner_name.replace(/`/g, "'")}\`` : 'none assigned'}`,
    '- Related rules: none recorded (no result)',
    `- ${stepsLabel}:`,
    '',
    fence(cap(steps.join('\n') || 'none reported')),
    '',
    FOOTER,
  ].join('\n');
  return { title: `Job failed: ${name}`, body };
}

/** Turns a run's results, its jobs and its plan into `request` Issues, and reports every decision. */
export async function report(input: ReportInput): Promise<{ output: ReportOutput; failed: boolean }> {
  const { gh, env, registry, leg } = input;
  const decisions: Decision[] = [];
  const runLink = `${env.serverUrl}/${E2E_REPO}/actions/runs/${env.runId}`;

  let plan: PlanView | null = null;
  if (leg) {
    decisions.push({ subject: 'plan', decision: 'left to the final report', reason: `leg mode on runner ${leg.runner}: other jobs, plan gaps, unselected gaps and the coverage check are filed or checked by the final report` });
  } else if ('error' in input.plan) decisions.push({ subject: 'plan', decision: 'no plan', reason: input.plan.error });
  else {
    const view = readPlanView(input.plan.text);
    if ('error' in view) decisions.push({ subject: 'plan', decision: 'no plan', reason: `unusable plan: ${view.error}` });
    else plan = view;
  }

  const { data: run } = await gh.rest<{ created_at?: string; run_attempt?: number }>('GET', `/repos/${E2E_REPO}/actions/runs/${env.runId}`);
  if (typeof run.created_at !== 'string') throw new Error(`GitHub GET run ${env.runId}: no created_at`);
  const allJobs = await gh.list<Job>(`/repos/${E2E_REPO}/actions/runs/${env.runId}/jobs?filter=latest`, 'jobs');
  const jobs = allJobs.filter((j) => j.status === 'completed');

  const usable: UsableResult[] = [];
  for (const file of input.results) {
    const r = file.text === undefined ? { error: file.error ?? 'unreadable' } : validateResult(file.path, file.text, registry);
    if ('error' in r) decisions.push({ subject: file.path, decision: 'no result', reason: r.error });
    else {
      usable.push(r);
      decisions.push({ subject: file.path, decision: 'result used', reason: `${r.platform}, runner ${r.runner ?? 'unknown'}` });
    }
  }
  if (input.results.length === 0) decisions.push({ subject: 'results', decision: 'no result files', reason: 'the job conclusions are used' });

  // Any status: a leg's own job is still in progress when its final step files.
  const jobFor = (runner: string | null) => (runner === null ? null : (allJobs.find((j) => j.runner_name === runner)?.html_url ?? null));
  const failures = new Map<string, Occurrence[]>();
  const add = (title: string, o: Occurrence) => failures.set(title, [...(failures.get(title) ?? []), o]);
  for (const r of usable) {
    const base = { platform: r.platform, runner: r.runner, job: jobFor(r.runner) };
    const legRules = [...new Set(r.scenarios.flatMap((s) => s.rules))];
    for (const p of r.provisioning) {
      if (p.status === 'failed' && !p.blockedBy) add(`Provisioning failed: ${p.id}`, { ...base, reason: p.reason, rules: rulesBlockedBy(r, p.id) });
    }
    for (const s of r.scenarios) {
      if (s.status === 'failed' && !s.blockedBy) add(`Scenario failed: ${s.id}`, { ...base, reason: s.reason, rules: s.rules });
      if (s.status === 'waiting') decisions.push({ subject: `scenario ${s.id} (${r.platform})`, decision: 'waiting, listed only', reason: s.reason });
    }
    for (const t of r.teardown) {
      if (t.status === 'failed') add(`Teardown failed: ${t.id}`, { ...base, reason: t.reason, rules: legRules });
    }
  }

  const subjects: Subject[] = [];
  const runLine = `The release gate run ${runLink} (attempt ${run.run_attempt ?? 1}) reported this.`;
  for (const [title, occurrences] of failures) {
    const kind = title.slice(0, title.indexOf(':'));
    const platforms = [...new Set(occurrences.map((o) => o.platform))];
    const render = (some: readonly string[]) => {
      const these = occurrences.filter((o) => some.includes(o.platform));
      return occurrencesBody(`${runLine}\n\n**${kind}** in ${these.length} leg${these.length === 1 ? '' : 's'}.`, these);
    };
    subjects.push({ title, body: render(platforms), legs: { platforms, render } });
    decisions.push({ subject: title, decision: 'failure: request', reason: occurrences.map((o) => `${o.platform}: ${cap(o.reason, 200)}`).join('; ') });
  }

  if (!leg) {
    const resultRunners = new Set(usable.map((r) => r.runner).filter((r) => r !== null));
    for (const job of jobs) {
      if (!['failure', 'cancelled', 'timed_out'].includes(job.conclusion ?? '')) continue;
      if (job.runner_name && resultRunners.has(job.runner_name)) continue;
      const steps = (job.steps ?? []).filter((s) => s.conclusion !== 'success' && s.conclusion !== 'skipped').map((s) => `${s.name ?? 'unnamed step'}: ${s.conclusion ?? 'no conclusion'}`);
      const subject = jobFailed(job, runLine, `A job ended with conclusion \`${job.conclusion}\` and left no usable result.`, 'Steps that did not succeed', steps);
      subjects.push(subject);
      decisions.push({ subject: subject.title, decision: 'failure: request', reason: `conclusion ${job.conclusion}; no result from runner ${job.runner_name ?? 'none'}` });
    }
  } else if (usable.length === 0) {
    const own = allJobs.find((j) => j.runner_name === leg.runner);
    if (!own) {
      decisions.push({ subject: `job on runner ${leg.runner}`, decision: 'not found, left to the final report', reason: 'no job of this run has this runner name' });
    } else {
      // Steps still running or queued have no conclusion yet; list only the ones that ended badly.
      const steps = (own.steps ?? []).filter((s) => s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped').map((s) => `${s.name ?? 'unnamed step'}: ${s.conclusion}`);
      const subject = jobFailed(own, runLine, 'This job left no usable result; its leg filed this from its final step, before the job ended.', 'Steps that did not succeed so far', steps);
      subjects.push(subject);
      decisions.push({ subject: subject.title, decision: 'failure: request', reason: `no usable result from runner ${leg.runner}` });
    }
  }
  const failureCount = subjects.length;

  for (const gap of plan?.gaps ?? []) {
    const title = `Coverage gap: ${gap.id}`;
    const missing = gap.missing === NOT_IN_MAP ? `${gap.id} is ${NOT_IN_MAP}` : `no scenario on ${gap.missing.join(', ')}`;
    const from = plan?.source?.url ? ` It was selected by ${plan.source.url}.` : '';
    const body = [
      `Rule ${gap.id} was selected in the release gate run ${runLink}, but ${missing}.${from}`,
      '',
      'Every rule the Proposal does not mark 〔不測：…〕 needs a scenario on each platform it requires (Proposal R8.15, R8.16).',
      '',
      FOOTER,
    ].join('\n');
    subjects.push({ title, body });
    decisions.push({ subject: title, decision: 'coverage gap: request', reason: missing });
  }
  for (const g of plan?.unselectedGaps ?? []) {
    decisions.push({ subject: g.id, decision: 'listed, not filed', reason: `uncovered, not selected; no scenario on ${g.missingPlatforms.join(', ')}` });
  }

  const filed: Filed[] = [];
  if (subjects.length) {
    const ctx = await filingContext(gh, env.runId, run.created_at, subjects.map((s) => s.title));
    for (const s of subjects) filed.push(await fileSubject(ctx, s));
  }
  for (const f of filed) decisions.push({ subject: f.title, decision: f.decision, reason: f.url ? `${f.url}: ${f.reason}` : f.reason });
  const filingFailed = filed.some((f) => f.decision === 'failed');

  if (leg) {
    // A leg fails only for its own failures and filings; the final report judges the rest.
    return { output: { decisions, filed, coverage: null, summary: decisionTable('Gate report for this leg', decisions) }, failed: failureCount > 0 || filingFailed };
  }

  const coverage = plan?.coverage ?? null;
  decisions.push({
    subject: 'coverage check',
    decision: coverage === null ? 'failed: unknown' : coverage.passed ? 'passed' : 'failed',
    reason: coverage === null ? 'no usable plan' : `${coverage.covered}/${coverage.total} rules covered${plan?.selection.all ? '' : '; fails the run only for --all'}`,
  });

  // The whole-map coverage check fails only the pre-release `--all` run (R8.16); any other run is
  // red only for its own selection: failures, selected gaps and failed filings. Without a usable
  // plan the gate cannot tell whether the run was `--all`, so it fails.
  const coverageFails = plan === null || (plan.selection.all && plan.coverage.passed !== true);
  const selectedGaps = plan?.gaps.length ?? 0;
  const failed = failureCount > 0 || selectedGaps > 0 || filingFailed || coverageFails;
  return { output: { decisions, filed, coverage, summary: decisionTable('Gate report', decisions) }, failed };
}
