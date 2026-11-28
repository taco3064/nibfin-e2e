export class GitHubError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, message: string) {
    super(`GitHub ${method} ${path} returned ${status}: ${message}`);
    this.status = status;
  }
}

/**
 * A request that got no response at all: `fetch` rejected before any status arrived
 * (DNS, a reset connection, a connect timeout, TLS). Deliberately not a `GitHubError`,
 * so callers that branch on `instanceof GitHubError` keep treating it as "no status".
 * The message names the call and the lowest-level cause; the original rejection stays
 * attached as `cause`.
 */
export class GitHubNoResponse extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'GitHubNoResponse';
  }
}

export interface GitHub {
  /** One REST call. Statuses listed in `allow` are returned instead of thrown. */
  rest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    allow?: number[],
  ): Promise<{ status: number; data: T }>;
  /** Every page of a list endpoint; `key` picks the array out of wrapped responses (`runners`, `secrets`). */
  list<T = unknown>(path: string, key?: string): Promise<T[]>;
  /**
   * Every page of a list endpoint that pages with cursors in the `Link` header (for
   * example repository activity), up to `maxPages`. Only API-host links are followed.
   */
  listByLink<T = unknown>(path: string, maxPages?: number): Promise<T[]>;
  graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T>;
  /**
   * A plain-text download such as a Job log. A redirect is followed without the
   * Authorization header, and its URL is never put into an error or a log.
   */
  download(path: string, allow?: number[]): Promise<{ status: number; text: string }>;
}

/** Opt-in wait for a rate-limited read: a `GET` that GitHub answers with a rate-limit 403 or 429. */
export interface RateLimitWait {
  /** One line per wait with the method, the path, the status and the seconds; never headers or the token. */
  log: (line: string) => void;
  /** Most a single request (one call, or one page of a list) may wait in total; default 65 minutes. */
  maxWaitMs?: number;
  /** Defaults to a timer; tests inject one that does not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

/** Opt-in retry for a `GET` that gets no response; independent of the rate-limit wait. */
export interface NoResponseRetry {
  /** One line per retry with the method, the path and the cause code; never the token or a redirect URL. */
  log: (line: string) => void;
  /** Total tries for a `GET` that gets no response; default 3. */
  tries?: number;
  /** Pause between tries; default 3000 ms. */
  delayMs?: number;
  /** Defaults to a timer; tests inject one that does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_NO_RESPONSE_TRIES = 3;
const DEFAULT_NO_RESPONSE_DELAY_MS = 3000;

/**
 * The lowest-level cause of a rejected `fetch`: the deepest string `code` along the
 * `cause` chain (an `AggregateError` without its own code is followed into its first
 * entry), otherwise the deepest message.
 */
function rootCause(error: unknown): { code?: string; message?: string } {
  let code: string | undefined;
  let message: string | undefined;
  let cur: unknown = error;
  for (let depth = 0; depth < 6 && cur instanceof Object; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.code === 'string' && e.code) code = e.code;
    if (typeof e.message === 'string' && e.message) message = e.message;
    if (e.cause !== undefined) cur = e.cause;
    else if (typeof e.code !== 'string' && Array.isArray(e.errors) && e.errors.length > 0) cur = e.errors[0];
    else break;
  }
  return { code, message };
}

const isAbort = (error: unknown) =>
  error instanceof Object && ['AbortError', 'TimeoutError'].includes((error as { name?: unknown }).name as string);

const DEFAULT_MAX_WAIT_MS = 65 * 60_000;
const MINUTE_MS = 60_000;

/**
 * How long GitHub asks a rate-limited response to wait, in GitHub's documented order:
 * `retry-after`, then `x-ratelimit-remaining: 0` with `x-ratelimit-reset` (epoch
 * seconds), then a secondary-limit message with exponential back-off. `undefined` when
 * the response is not a rate limit, such as a permission 403.
 */
function rateLimitDelay(
  status: number,
  headers: Headers,
  data: unknown,
  now: number,
  secondaryTries: number,
): number | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  if (headers.get('x-ratelimit-remaining')?.trim() === '0') {
    const reset = headers.get('x-ratelimit-reset')?.trim();
    if (reset === undefined || !/^\d+$/.test(reset)) return MINUTE_MS;
    return Math.max(0, Number(reset) * 1000 - now) + 1000;
  }
  const message = (data as { message?: unknown } | undefined)?.message;
  if (typeof message === 'string' && /secondary rate limit/i.test(message)) return MINUTE_MS * 2 ** secondaryTries;
  return undefined;
}

const seconds = (ms: number) => Math.ceil(ms / 1000);

function parseBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

/** One attempt of a request: the response, its parsed body, and the error it fails with, if any. */
interface Attempt<R> {
  res: Response;
  data: unknown;
  error: GitHubError | undefined;
  result: R;
}

/**
 * REST and GraphQL on native fetch. The token is read per call (so a missing variable
 * fails the step that needs it) and travels only in the Authorization header.
 * Writes (every non-GET call, GraphQL included) are never repeated: every caller
 * converges idempotently and the next run redoes it. With `wait`, a read that GitHub
 * rate-limits (403 or 429) waits until the reset or for `retry-after` and is then
 * repeated, up to `maxWaitMs` in total per request; a longer wait is not started and the
 * read fails at once. Without `wait`, every failure is thrown at once.
 * A request that gets no response (`fetch` rejects) always fails with a
 * `GitHubNoResponse` naming the call and its lowest-level cause. With `retry`, a `GET`
 * that gets no response is sent again, up to `tries` times in total with `delayMs`
 * between tries; that bound is separate from the rate-limit wait. Writes, responses of
 * any status and aborts are never retried this way.
 */
export function createGitHub(
  token: () => string,
  fetchFn: typeof fetch = fetch,
  api = 'https://api.github.com',
  wait?: RateLimitWait,
  retry?: NoResponseRetry,
): GitHub {
  const sleep = wait?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = wait?.now ?? Date.now;
  const maxWaitMs = wait?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const headers = (extra: Record<string, string> = {}) => ({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token()}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nibfin-e2e',
    ...extra,
  });
  const retrySleep =
    retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryTries = Math.max(1, retry?.tries ?? DEFAULT_NO_RESPONSE_TRIES);
  const retryDelayMs = retry?.delayMs ?? DEFAULT_NO_RESPONSE_DELAY_MS;
  /**
   * One `fetchFn` call that turns a rejection into a `GitHubNoResponse` and, with
   * `retry`, repeats a `GET` that got no response. Any response, of any status, is
   * returned at once. `init` is built per try, so the token is read per call. For the
   * redirected download step only the cause code is used, so nothing from the signed URL
   * can enter a message or a log line.
   */
  async function send(method: string, path: string, url: string, init: () => RequestInit, redirected = false) {
    const call = redirected ? `GitHub ${method} ${path}: the redirected download` : `GitHub ${method} ${path}`;
    for (let tryNo = 1; ; tryNo++) {
      try {
        return await fetchFn(url, init());
      } catch (error) {
        if (isAbort(error)) throw error;
        const root = rootCause(error);
        const cause = redirected ? (root.code ?? 'no error code') : (root.code ?? root.message ?? 'unknown cause');
        if (retry && method === 'GET' && tryNo < retryTries) {
          retry.log(
            `${call} got no response (${cause}); trying again in ${seconds(retryDelayMs)} s (try ${tryNo + 1} of ${retryTries})`,
          );
          await retrySleep(retryDelayMs);
          continue;
        }
        const tries = tryNo > 1 ? ` (after ${tryNo} tries)` : '';
        throw new GitHubNoResponse(`${call} got no response: ${cause}${tries}`, { cause: error });
      }
    }
  }
  function append(err: GitHubError, suffix: string) {
    err.message += suffix;
    return err;
  }
  /** Repeats `send` while it is a rate-limited read that the wait covers; throws its final error. */
  async function attempt<R>(method: string, path: string, send: () => Promise<Attempt<R>>): Promise<R> {
    let waited = 0;
    let secondaryTries = 0;
    for (;;) {
      const a = await send();
      if (!a.error) return a.result;
      let err = a.error;
      const delay =
        wait && method === 'GET'
          ? rateLimitDelay(a.res.status, a.res.headers, a.data, now(), secondaryTries)
          : undefined;
      if (wait && delay !== undefined) {
        if (waited + delay <= maxWaitMs) {
          wait.log(`GitHub ${method} ${path} rate-limited (${a.res.status}); waiting ${seconds(delay)} s`);
          await sleep(delay);
          waited += delay;
          if (!a.res.headers.has('retry-after') && a.res.headers.get('x-ratelimit-remaining')?.trim() !== '0')
            secondaryTries++;
          continue;
        }
        err = append(err, `; rate limit resets in ${seconds(delay)} s, beyond the ${seconds(maxWaitMs)} s wait limit`);
      }
      throw waited > 0 ? append(err, ` (after waiting ${seconds(waited)} s for the rate limit)`) : err;
    }
  }
  async function call(method: string, path: string, body: unknown, allow: number[]) {
    return callUrl(method, api + path, path, body, allow);
  }
  async function callUrl(method: string, url: string, path: string, body: unknown, allow: number[]) {
    return attempt(method, path, async () => {
      const res = await send(method, path, url, () => ({
        method,
        headers: headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
      const text = await res.text();
      const data = parseBody(text);
      let error: GitHubError | undefined;
      if (!res.ok && !allow.includes(res.status)) {
        const message = (data as { message?: unknown } | undefined)?.message;
        error = new GitHubError(method, path, res.status, typeof message === 'string' ? message : text.slice(0, 500));
      }
      return { res, data, error, result: { status: res.status, data, link: res.headers.get('link') ?? '' } };
    });
  }

  const gh: GitHub = {
    async rest<T>(method: string, path: string, body?: unknown, allow: number[] = []) {
      const r = await call(method, path, body, allow);
      return { status: r.status, data: r.data as T };
    },
    async list<T>(path: string, key?: string) {
      const out: T[] = [];
      for (let page = 1; ; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const { data } = await call('GET', `${path}${sep}per_page=100&page=${page}`, undefined, []);
        const items = (key ? (data as Record<string, unknown>)[key] : data) as T[] | undefined;
        if (!Array.isArray(items)) throw new Error(`GitHub GET ${path}: expected a list`);
        out.push(...items);
        if (items.length < 100) return out;
      }
    },
    async listByLink<T>(path: string, maxPages = 50) {
      const out: T[] = [];
      const sep = path.includes('?') ? '&' : '?';
      let url = `${api}${path}${sep}per_page=100`;
      for (let page = 0; page < maxPages; page++) {
        const r = await callUrl('GET', url, path, undefined, []);
        if (!Array.isArray(r.data)) throw new Error(`GitHub GET ${path}: expected a list`);
        out.push(...(r.data as T[]));
        const next = /<([^>]+)>;\s*rel="next"/.exec(r.link)?.[1];
        // The token goes only to the API host.
        if (!next || !next.startsWith(api + '/')) return out;
        url = next;
      }
      throw new Error(`GitHub GET ${path}: more than ${maxPages} pages`);
    },
    async graphql<T>(query: string, variables: Record<string, unknown>) {
      const { data } = await call('POST', '/graphql', { query, variables }, []);
      const d = data as { data?: T; errors?: { message: string }[] };
      if (d.errors?.length) throw new Error(`GitHub GraphQL: ${d.errors.map((e) => e.message).join('; ')}`);
      return d.data as T;
    },
    async download(path: string, allow: number[] = []) {
      // Only the API-host response can be waited out; the redirected one never is.
      const first = await attempt('GET', path, async () => {
        const res = await send('GET', path, api + path, () => ({ method: 'GET', headers: headers(), redirect: 'manual' }));
        if (res.ok || (res.status >= 300 && res.status < 400) || allow.includes(res.status)) {
          return { res, data: undefined, error: undefined, result: res };
        }
        const text = await res.text();
        const error = new GitHubError('GET', path, res.status, text.slice(0, 500));
        return { res, data: parseBody(text), error, result: res };
      });
      let final = first;
      if (final.status >= 300 && final.status < 400) {
        const location = final.headers.get('location');
        await final.body?.cancel();
        if (!location) throw new GitHubError('GET', path, final.status, 'redirect without a Location header');
        final = await send('GET', path, location, () => ({ method: 'GET', headers: { 'User-Agent': 'nibfin-e2e' } }), true);
      }
      const text = await final.text();
      if (!final.ok && !allow.includes(final.status)) {
        throw new GitHubError(
          'GET',
          path,
          final.status,
          final === first ? text.slice(0, 500) : 'the redirected download failed',
        );
      }
      return { status: final.status, text };
    },
  };
  return gh;
}
