export interface WaitOptions {
  /** What is awaited, for the failure reason. */
  what: string;
  deadlineMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const show = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 400 ? s.slice(0, 400) + '…' : s;
};

/**
 * Polls `read` within this run until `until` holds, and fails with the last value seen
 * once the deadline passes. A throw from `read` counts as a value and is retried.
 */
export async function waitFor<T>(read: () => Promise<T>, until: (value: T) => boolean, options: WaitOptions): Promise<T> {
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const interval = options.intervalMs ?? 10_000;
  const end = now() + options.deadlineMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (until(value)) return value;
      last = value;
    } catch (error) {
      last = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (now() >= end) break;
    await pause(Math.max(0, Math.min(interval, end - now())));
  }
  throw new Error(`timed out after ${Math.round(options.deadlineMs / 1000)} s waiting for ${options.what}; last seen: ${show(last)}`);
}
