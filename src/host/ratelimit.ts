import { DEFAULT_MAX_WAIT_MS, resetDelay } from './github.ts';
import type { GitHub } from './github.ts';

/** The token's core REST limit as `GET /rate_limit` reports it. */
export interface CoreLimit {
  limit: number;
  remaining: number;
  /** When the window resets, in epoch milliseconds. */
  resetAt: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Reads the core REST limit of the token behind `github`. GitHub documents that this
 * endpoint does not count against the primary REST limit. Throws when the body has no
 * integer `resources.core.limit`, `remaining` and `reset`.
 */
export async function readCoreLimit(github: GitHub): Promise<CoreLimit> {
  const { data } = await github.rest<{ resources?: { core?: Record<string, unknown> } }>('GET', '/rate_limit');
  const core = data?.resources?.core;
  const { limit, remaining, reset } = core ?? {};
  if (!Number.isInteger(limit) || !Number.isInteger(remaining) || !Number.isInteger(reset))
    throw new Error('GitHub GET /rate_limit returned no integer resources.core limit, remaining and reset');
  return { limit: limit as number, remaining: remaining as number, resetAt: (reset as number) * 1000 };
}

/** The limit as a reason names it: remaining of limit and the reset as an ISO time. */
export function describeLimit(l: CoreLimit): string {
  return `${l.remaining} of ${l.limit} core REST calls left, resetting at ${new Date(l.resetAt).toISOString()}`;
}

export interface CoreLimitWait {
  /** One line when it waits, cannot wait or cannot read the limit; never headers or the token. */
  log: (line: string) => void;
  /** Waits when fewer calls than this are left; default 500, a tenth of the standard 5,000 per hour. */
  minRemaining?: number;
  /** A reset further away than this is not waited for; default 65 minutes, as for the harness's own reads. */
  maxWaitMs?: number;
  /** What the wait is for, for the log line (for example `gh nibfin runner remove`). */
  what?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface CoreLimitWaited {
  read?: CoreLimit;
  readError?: string;
  waitedMs: number;
}

/**
 * Before a command that spends the same token's limit: reads the core REST limit and,
 * when fewer than `minRemaining` calls are left, sleeps until the reset plus one second,
 * if that is within `maxWaitMs`. A failed read or a reset beyond the bound is logged and
 * the caller goes on without waiting; this never throws for the limit itself.
 */
export async function waitForCoreLimit(github: GitHub, opts: CoreLimitWait): Promise<CoreLimitWaited> {
  const minRemaining = opts.minRemaining ?? 500;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const before = opts.what ? ` before ${opts.what}` : '';
  let read: CoreLimit;
  try {
    read = await readCoreLimit(github);
  } catch (error) {
    const readError = message(error);
    opts.log(`reading the GitHub core REST limit${before} failed (${readError}); running without waiting`);
    return { readError, waitedMs: 0 };
  }
  if (read.remaining >= minRemaining) return { read, waitedMs: 0 };
  const delay = resetDelay(read.resetAt / 1000, now());
  const s = Math.ceil(delay / 1000);
  if (delay > maxWaitMs) {
    opts.log(
      `GitHub core REST limit has ${read.remaining} of ${read.limit} left; the reset in ${s} s is beyond the ${Math.ceil(maxWaitMs / 1000)} s wait limit, running${before} without waiting`,
    );
    return { read, waitedMs: 0 };
  }
  opts.log(`GitHub core REST limit has ${read.remaining} of ${read.limit} left; waiting ${s} s for the reset${before}`);
  await sleep(delay);
  return { read, waitedMs: delay };
}
