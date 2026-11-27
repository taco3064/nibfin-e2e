import { GitHubError } from '../../src/host/github.ts';
import type { GitHub } from '../../src/host/github.ts';
import { rulesets } from '../../src/host/sandbox.ts';
import { deleteFile, putFile } from './github.ts';
import { sleep, waitFor } from './wait.ts';

export const HOLD_PATH = '.github/workflows/e2e-hold.yml';

/**
 * The default-branch ruleset `Kit.baseline` (scenarios/lifecycle/kit.ts) creates on the
 * execution sandbox. It requires the `test` check, so it refuses the hold's direct writes
 * to main while it is active.
 */
export const CI_RULESET = 'e2e-ci';

interface RulesetDetail {
  id: number;
  name: string;
  target?: string;
  enforcement: string;
  conditions?: unknown;
  rules?: unknown[];
  bypass_actors?: unknown[];
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs one write to main with the named ruleset's enforcement switched to `disabled`, then
 * restores the enforcement read before and confirms it by read-back. Without the ruleset,
 * or when it is not active, the write runs alone. Only that ruleset's `enforcement`
 * changes: every other writable field is sent back as read. A failed restore throws a
 * message naming the ruleset and the enforcement read back; a failed write is otherwise
 * rethrown unchanged after the restore.
 */
export async function withRulesetLifted<T>(gh: GitHub, repo: string, name: string, write: () => Promise<T>): Promise<T> {
  const found = (await rulesets(gh, repo)).find((r) => r.name === name);
  if (!found) return write();
  const path = `/repos/${repo}/rulesets/${found.id}`;
  const read = (await gh.rest<RulesetDetail>('GET', path)).data;
  const original = read.enforcement;
  if (original !== 'active') return write();
  const body = (enforcement: string) => ({
    name: read.name,
    target: read.target,
    conditions: read.conditions,
    rules: read.rules,
    ...(read.bypass_actors !== undefined ? { bypass_actors: read.bypass_actors } : {}),
    enforcement,
  });
  await gh.rest('PUT', path, body('disabled'));
  let failed = false;
  let writeError: unknown;
  try {
    return await write();
  } catch (error) {
    failed = true;
    writeError = error;
    throw error;
  } finally {
    let problem: string | undefined;
    try {
      await gh.rest('PUT', path, body(original));
    } catch (error) {
      problem = `the restore failed (${errorMessage(error)})`;
    }
    let back: string;
    try {
      back = `enforcement ${(await gh.rest<RulesetDetail>('GET', path)).data.enforcement}`;
    } catch (error) {
      back = `an enforcement that could not be read (${errorMessage(error)})`;
    }
    if (problem !== undefined || back !== `enforcement ${original}`) {
      let message = `${name} on ${repo} reads back ${back} after restore; expected ${original}`;
      if (problem !== undefined) message += `; ${problem}`;
      if (failed) message += `; the write had failed: ${errorMessage(writeError)}`;
      // eslint-disable-next-line no-unsafe-finally
      throw new Error(message, failed ? { cause: writeError } : undefined);
    }
  }
}

/**
 * A plain workflow that keeps one self-hosted Runner busy without an agent. Inputs reach
 * the script only through `env`; a run that starts after `notAfter` (epoch seconds) exits
 * at once, so a run a crashed leg left queued cannot hold a later host's Runner.
 */
export const HOLD_WORKFLOW = `name: e2e hold
on:
  workflow_dispatch:
    inputs:
      seconds:
        required: true
      notAfter:
        required: true
permissions: {}
jobs:
  hold:
    runs-on: self-hosted
    timeout-minutes: 10
    steps:
      - name: Hold the Runner
        env:
          S: \${{ inputs.seconds }}
          NOT_AFTER: \${{ inputs.notAfter }}
        run: |
          case "$S" in ''|*[!0-9]*) echo "seconds must be digits"; exit 1;; esac
          case "$NOT_AFTER" in ''|*[!0-9]*) echo "notAfter must be digits"; exit 1;; esac
          if [ "$(date +%s)" -gt "$NOT_AFTER" ]; then echo "past notAfter; not holding"; exit 0; fi
          sleep "$S"
`;

export interface Hold {
  runId: number;
  /** The Runner that took the job. */
  runnerName: string;
}

interface Job {
  status: string;
  conclusion: string | null;
  runner_name: string | null;
}

async function jobs(gh: GitHub, repo: string, runId: number): Promise<Job[]> {
  return gh.list<Job>(`/repos/${repo}/actions/runs/${runId}/jobs`, 'jobs');
}

/** Commits the hold workflow to main (idempotent). */
export async function installHold(gh: GitHub, repo: string): Promise<void> {
  await withRulesetLifted(gh, repo, CI_RULESET, () => putFile(gh, repo, HOLD_PATH, HOLD_WORKFLOW, 'nibfin-e2e: add the hold fixture workflow'));
}

/** Dispatches a hold and waits until its job runs on a Runner. */
export async function startHold(gh: GitHub, repo: string, seconds: number): Promise<Hold> {
  await installHold(gh, repo);
  const notAfter = String(Math.floor(Date.now() / 1000) + 300);
  const since = new Date(Date.now() - 5000).toISOString();
  const body = { ref: 'main', inputs: { seconds: String(seconds), notAfter }, return_run_details: true };
  // A just-committed workflow can take a moment before GitHub accepts a dispatch for it.
  const url = `/repos/${repo}/actions/workflows/e2e-hold.yml/dispatches`;
  const dispatch = async () => {
    try {
      return await gh.rest<{ workflow_run_id?: number } | undefined>('POST', url, body);
    } catch (error) {
      // Without support for run details GitHub refuses the flag; dispatch plainly and find the run below.
      if (!(error instanceof GitHubError) || error.status !== 422 || !/return_run_details/.test(error.message)) throw error;
      return gh.rest<undefined>('POST', url, { ref: body.ref, inputs: body.inputs });
    }
  };
  const dispatched = await waitFor(
    dispatch,
    () => true,
    { what: 'the hold dispatch to be accepted', deadlineMs: 90_000, intervalMs: 10_000 },
  );
  let runId = dispatched.data?.workflow_run_id;
  if (typeof runId !== 'number') {
    const run = await waitFor(
      async () => {
        const runs = await gh.rest<{ workflow_runs: { id: number; created_at: string }[] }>(
          'GET',
          `/repos/${repo}/actions/workflows/e2e-hold.yml/runs?event=workflow_dispatch&per_page=20`,
        );
        return runs.data.workflow_runs.filter((r) => r.created_at >= since).sort((a, b) => a.id - b.id)[0];
      },
      (r) => r !== undefined,
      { what: 'the dispatched hold run to be listed', deadlineMs: 120_000, intervalMs: 5000 },
    );
    runId = (run as { id: number }).id;
  }
  const id = runId;
  const [job] = await waitFor(
    () => jobs(gh, repo, id),
    (js) => js[0]?.status === 'in_progress' && !!js[0].runner_name,
    { what: `hold run ${id} to start on a Runner`, deadlineMs: 5 * 60_000, intervalMs: 5000 },
  );
  return { runId: id, runnerName: (job as Job).runner_name as string };
}

/** Waits for the hold's job to end and returns its conclusion. */
export async function finishHold(gh: GitHub, repo: string, hold: Hold): Promise<string> {
  const [job] = await waitFor(() => jobs(gh, repo, hold.runId), (js) => js[0]?.status === 'completed', {
    what: `hold run ${hold.runId} to complete`,
    deadlineMs: 10 * 60_000,
    intervalMs: 10_000,
  });
  return String((job as Job).conclusion);
}

export async function removeHold(gh: GitHub, repo: string): Promise<void> {
  await withRulesetLifted(gh, repo, CI_RULESET, () => deleteFile(gh, repo, HOLD_PATH, 'nibfin-e2e: remove the hold fixture workflow'));
}

export { sleep };
