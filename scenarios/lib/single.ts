import { watchJobContainers } from './containers.ts';
import type { Projection } from './containers.ts';
import { TASK_BODY } from './files.ts';
import { addLabel, comments, issueState, labels, openFixture } from './fixture.ts';
import type { Comment } from './fixture.ts';
import { jobLog } from './joblog.ts';
import type { StageJob } from './joblog.ts';
import { message } from './kit.ts';
import type { Kit } from './kit.ts';
import { DEADLINE, remoteWait } from './waits.ts';

/** What the published-Shape wait saw when the Issue first showed `shaped`. */
export interface ShapedSeen {
  /** kit.now() when the labels showing `shaped` were read. */
  at: number;
  /** The labels of that read. */
  labels: string[];
  /** The Issue's comments, read together with adding `pause`; undefined when that read failed. */
  comments?: Comment[];
  /** Why that comments read failed, when it did. */
  commentsError?: string;
}

export interface FirstJob {
  issue: number;
  /** The projection taken when the container started; undefined when it was already gone. */
  projection?: Projection;
  log?: { job: StageJob; text: string; secretFound: boolean };
  /** Why the log could not be read, when it could not. */
  logError?: string;
  /** Set only with pauseWhenShaped: what the wait saw when the Issue showed `shaped`. */
  shaped?: ShapedSeen;
}

/** How long after the Shape Job container ended `shaped` may still appear: the bound for a Job's results showing on GitHub. */
export const SHAPED_GRACE = DEADLINE.jobLog;

/** How often the published-Shape wait re-reads the Issue's labels. */
const SHAPED_INTERVAL = 10_000;

/**
 * Opens a fixture Issue and waits, on container events, for its first Job container to
 * start and end, then reads that Job's log. With `pause`, `pause` is added as soon as the
 * container starts, so no later stage follows. With `pauseWhenShaped`, no `pause` is added
 * while the Shape runs: once the container started, the Issue's labels are re-read until it
 * shows `shaped` (the Shape was published), and only then is `pause` added, so no later
 * stage follows; the labels of that read and the comments read with adding `pause` are
 * returned as `shaped`, so checks can judge the Issue as published, not as it is later. That
 * wait fails early when the Issue gets `pending`, or when the container
 * ended and no `shaped` followed within SHAPED_GRACE. The two options cannot be combined.
 */
export async function runFirstJob(
  kit: Kit,
  repo: string,
  opts: { title: string; file: string; deadlineMs: number; stage: string; pause?: boolean; pauseWhenShaped?: boolean; onOpen?: (issue: number) => void },
): Promise<FirstJob> {
  if (opts.pause && opts.pauseWhenShaped) throw new Error('runFirstJob: pause and pauseWhenShaped cannot be combined');
  const issue = await openFixture(kit, repo, opts.title, TASK_BODY);
  opts.onOpen?.(issue);
  const watch = watchJobContainers(kit, repo, issue, async (_e, index) => {
    if (opts.pause && index === 0) await addLabel(kit, repo, issue, 'pause');
  });
  let over = false;
  try {
    const start = await watch.started(1, opts.deadlineMs, `the ${opts.stage} Job container of ${repo}#${issue} to start`);
    const ended = () => watch.events.some((e) => e.kind === 'died' && e.id === start.id);
    const shaped = opts.pauseWhenShaped ? pauseWhenShaped(kit, repo, issue, opts.deadlineMs, ended, () => over) : undefined;
    // Marked handled at once, so a rejection while the projection is read is not unhandled; Promise.all below still sees it.
    shaped?.catch(() => {});
    const projection = await watch.projection(start.id);
    const [, seen] = await Promise.all([watch.died(1, opts.deadlineMs, `the ${opts.stage} Job container of ${repo}#${issue} to end`), shaped]);
    const out: FirstJob = { issue, projection };
    if (seen) out.shaped = seen;
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
    over = true;
    watch.stop();
  }
}

/**
 * Re-reads the Issue's labels until it shows `shaped`, then adds `pause` at once, reading the
 * comments together with it, and returns that read's labels, its time and those comments. A
 * failed comments read is recorded as `commentsError` and does not fail the wait. Fails at once on
 * `pending`, when the Shape Job ended (`ended`) and no `shaped` followed within SHAPED_GRACE,
 * or when the call that started the wait is over (`over`). Its bound is the Shape deadline
 * plus the grace, so it never runs until the harness's stall check.
 */
async function pauseWhenShaped(kit: Kit, repo: string, issue: number, deadlineMs: number, ended: () => boolean, over: () => boolean): Promise<ShapedSeen> {
  let endedAt: number | undefined;
  return remoteWait<ShapedSeen>(kit, `the Shape of ${repo}#${issue} to be published (shaped)`, deadlineMs + SHAPED_GRACE, SHAPED_INTERVAL, async () => {
    if (over()) throw new Error(`the wait for the Shape of ${repo}#${issue} ended with its run`);
    const l = await labels(kit, repo, issue);
    if (l.includes('pending')) throw new Error(`the Shape of ${repo}#${issue} ended with pending`);
    if (l.includes('shaped')) {
      const seen: ShapedSeen = { at: kit.now(), labels: l };
      // `pause` is requested before any other read; the comments are read alongside it.
      const [, read] = await Promise.all([
        addLabel(kit, repo, issue, 'pause'),
        comments(kit, repo, issue).then(
          (cs) => ({ cs }),
          (error: unknown) => ({ error: message(error) }),
        ),
      ]);
      if ('cs' in read) seen.comments = read.cs;
      else seen.commentsError = read.error;
      return seen;
    }
    if (ended()) {
      endedAt ??= kit.now();
      if (kit.now() - endedAt > SHAPED_GRACE) throw new Error(`the Shape Job of ${repo}#${issue} ended and no shaped followed within ${Math.round(SHAPED_GRACE / 1000)} s`);
    }
    return undefined;
  });
}
