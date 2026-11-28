import { E2E_REPO } from '../host/config.ts';
import type { GitHub } from '../host/github.ts';

/** The workflow whose runs are the gate's retests; mirrors the file name in `.github/workflows/`. */
export const RETEST_WORKFLOW = 'e2e.yml';
/**
 * The start of the run name `e2e.yml` gives an `issue-delivered` dispatch (`e2e · retest <repo>#<n>`).
 * A run object does not carry the dispatch action, so this title is what tells a retest apart
 * from a `proposal-updated` run.
 */
export const RETEST_TITLE_PREFIX = 'e2e · retest ';

interface WorkflowRun {
  id?: number;
  conclusion?: string | null;
  display_title?: string;
  created_at?: string;
  run_started_at?: string;
}

const PER_PAGE = 100;

/**
 * When the newest completed, non-cancelled retest run of `e2e.yml` (other than `ownRunId`) was
 * queued: the earlier of its `run_started_at` and `created_at`. Queued runs report the queue time
 * as their start, and a re-run attempt may move the start later, so the earlier time never skips
 * an Issue delivered while that run waited or ran; such Issues are retested again instead.
 * Returns null when no such run exists. Pages one at a time, newest first, and stops at the
 * first match, because the run history only grows.
 */
export async function lastRetestStart(gh: GitHub, ownRunId?: string): Promise<string | null> {
  for (let page = 1; ; page++) {
    const { data } = await gh.rest<{ workflow_runs?: WorkflowRun[] }>(
      'GET',
      `/repos/${E2E_REPO}/actions/workflows/${RETEST_WORKFLOW}/runs?event=repository_dispatch&status=completed&per_page=${PER_PAGE}&page=${page}`,
    );
    const runs = data.workflow_runs;
    if (!Array.isArray(runs)) throw new Error(`GitHub GET ${RETEST_WORKFLOW} runs: expected workflow_runs`);
    for (const run of runs) {
      if (run.conclusion === 'cancelled') continue;
      if (typeof run.display_title !== 'string' || !run.display_title.startsWith(RETEST_TITLE_PREFIX)) continue;
      if (ownRunId !== undefined && String(run.id) === ownRunId) continue;
      const times = [run.run_started_at, run.created_at]
        .map((t) => (typeof t === 'string' ? Date.parse(t) : NaN))
        .filter((t) => !Number.isNaN(t));
      if (!times.length) continue;
      return new Date(Math.min(...times)).toISOString();
    }
    if (runs.length < PER_PAGE) return null;
  }
}
