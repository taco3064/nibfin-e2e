// Helpers for the run-wide abort signal: the harness budget aborts it once, at the work
// limit, so that waits inside the stuck work unwind through their own `finally` blocks.

/** A signal that never aborts, for contexts the budget does not stop (tests, teardown). */
export const NEVER: AbortSignal = new AbortController().signal;

/** The signal's reason as an Error. */
export function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new Error(r === undefined ? 'aborted' : String(r));
}

/** Throws the abort reason when the signal has aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/** `p`, or a rejection with the abort reason as soon as the signal aborts; the listener is removed once either settles. */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e as Error);
      },
    );
  });
}
