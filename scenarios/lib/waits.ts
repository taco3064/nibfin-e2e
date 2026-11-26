import type { Kit } from './kit.ts';

const MIN = 60_000;

/** Every deadline the scenarios use, in one place. */
export const DEADLINE = {
  shape: 60 * MIN,
  deliver: 120 * MIN,
  review: 60 * MIN,
  rejected: 15 * MIN,
  quiesce: 15 * MIN,
  finish: 20 * MIN,
  /** A Job's log after its container died: the Job's own post steps finish first. */
  jobLog: 5 * MIN,
  /** A restarted Runner showing online again on GitHub. */
  runnerOnline: 5 * MIN,
} as const;

/**
 * The only remote waits: GitHub state no local event reports (the finish Job on a
 * GitHub-hosted runner, a Job's log after its container ended, a restarted Runner's
 * registration). Re-reads every `intervalMs` until `check` returns a value or the
 * deadline passes, then throws naming `what`. They observe the system under test and
 * drive no Nibfin work.
 */
export async function remoteWait<T>(kit: Kit, what: string, deadlineMs: number, intervalMs: number, check: () => Promise<T | undefined>): Promise<T> {
  const end = kit.now() + deadlineMs;
  for (;;) {
    const got = await check();
    if (got !== undefined) return got;
    if (kit.now() >= end) throw new Error(`timed out after ${Math.round(deadlineMs / 1000)} s waiting for ${what}`);
    await kit.sleep(intervalMs);
  }
}
