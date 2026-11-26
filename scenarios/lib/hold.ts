import { GitHubError } from '../../src/host/github.ts';
import type { GitHub } from '../../src/host/github.ts';
import { deleteFile, putFile } from './github.ts';
import { sleep, waitFor } from './wait.ts';

export const HOLD_PATH = '.github/workflows/e2e-hold.yml';

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
  await putFile(gh, repo, HOLD_PATH, HOLD_WORKFLOW, 'nibfin-e2e: add the hold fixture workflow');
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
  await deleteFile(gh, repo, HOLD_PATH, 'nibfin-e2e: remove the hold fixture workflow');
}

export { sleep };
