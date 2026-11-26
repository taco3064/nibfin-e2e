import { watchJobContainers } from './containers.ts';
import type { Projection } from './containers.ts';
import { TASK_BODY } from './files.ts';
import { addLabel, issueState, openFixture } from './fixture.ts';
import { jobLog } from './joblog.ts';
import type { StageJob } from './joblog.ts';
import { message } from './kit.ts';
import type { Kit } from './kit.ts';

export interface FirstJob {
  issue: number;
  /** The projection taken when the container started; undefined when it was already gone. */
  projection?: Projection;
  log?: { job: StageJob; text: string };
  /** Why the log could not be read, when it could not. */
  logError?: string;
}

/**
 * Opens a fixture Issue and waits, on container events, for its first Job container to
 * start and end, then reads that Job's log. With `pause`, `pause` is added as soon as the
 * container starts, so no later stage follows.
 */
export async function runFirstJob(kit: Kit, repo: string, opts: { title: string; file: string; deadlineMs: number; stage: string; pause?: boolean }): Promise<FirstJob> {
  const issue = await openFixture(kit, repo, opts.title, TASK_BODY);
  const watch = watchJobContainers(kit, repo, issue, async (_e, index) => {
    if (opts.pause && index === 0) await addLabel(kit, repo, issue, 'pause');
  });
  try {
    const start = await watch.started(1, opts.deadlineMs, `the ${opts.stage} Job container of ${repo}#${issue} to start`);
    const projection = await watch.projection(start.id);
    await watch.died(1, opts.deadlineMs, `the ${opts.stage} Job container of ${repo}#${issue} to end`);
    const out: FirstJob = { issue, projection };
    if (!projection?.runId) out.logError = 'the container was gone before it could be inspected, so its run id is unknown';
    else {
      try {
        out.log = await jobLog(kit, projection.runRepo ?? kit.sandbox.execution, projection.runId, `${opts.file}-${issue}`);
      } catch (error) {
        out.logError = message(error);
      }
    }
    return out;
  } catch (error) {
    throw new Error(`${message(error)}; ${await issueState(kit, repo, issue)}`, { cause: error });
  } finally {
    watch.stop();
  }
}
