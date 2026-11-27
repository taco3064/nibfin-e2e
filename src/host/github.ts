export class GitHubError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, message: string) {
    super(`GitHub ${method} ${path} returned ${status}: ${message}`);
    this.status = status;
  }
}

export interface GitHub {
  /**
   * One REST call. Statuses listed in `allow` are returned instead of thrown, except a
   * rate-limit refusal, which a client with `rateLimit` waits out first.
   */
  rest<T = unknown>(method: string, path: string, body?: unknown, allow?: number[]): Promise<{ status: number; data: T }>;
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

/** How long a client may wait out GitHub's rate limits. */
export interface RateLimitPolicy {
  /** The longest single wait; a longer stated wait fails the call at once. */
  maxWaitMs: number;
  /** Rate-limit retries per call. */
  maxRetries: number;
  /** All waits of this client together; absent = no total cap. */
  maxTotalWaitMs?: number;
}

export interface GitHubOptions {
  /** Wait out rate-limit refusals; absent = no waiting (an immediate `GitHubError`, as before). */
  rateLimit?: RateLimitPolicy;
  /** Default: a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Default: `Date.now`. */
  now?: () => number;
  /** One line per wait. Default: none. */
  log?: (message: string) => void;
}

/** The harness: about an hour covers GitHub's hourly window; the run budget bounds the rest. */
export const HARNESS_RATE_LIMIT: RateLimitPolicy = { maxWaitMs: 61 * 60_000, maxRetries: 3 };
/** The gate CLI: its jobs time out after 10 minutes, setup included, so all waits stay within 4. */
export const GATE_RATE_LIMIT: RateLimitPolicy = { maxWaitMs: 2 * 60_000, maxRetries: 2, maxTotalWaitMs: 4 * 60_000 };

interface RateLimit {
  kind: 'primary' | 'secondary';
  waitMs: number;
  resetAt: string;
}

/**
 * A 403 or 429 that GitHub marks as a rate limit, and how long to wait before resending, as
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api states:
 * `retry-after` seconds; else, with `x-ratelimit-remaining: 0`, until `x-ratelimit-reset`
 * (plus one second for clock skew); else one minute, doubling on each later attempt.
 */
function rateLimitOf(res: Response, message: string, attempt: number, now: number): RateLimit | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const retryAfter = res.headers.get('retry-after');
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (retryAfter === null && remaining !== '0' && !/rate limit/i.test(message)) return undefined;
  const kind = retryAfter !== null || /secondary/i.test(message) ? 'secondary' : 'primary';
  const after = Number(retryAfter ?? NaN);
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? NaN);
  let waitMs: number;
  if (Number.isFinite(after) && after >= 0) waitMs = after * 1000;
  else if (remaining === '0' && Number.isFinite(reset) && reset > 0) waitMs = Math.max(1000, reset * 1000 - now + 1000);
  else waitMs = 60_000 * 2 ** attempt;
  return { kind, waitMs, resetAt: new Date(now + waitMs).toISOString() };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * REST and GraphQL on native fetch. The token is read per call (so a missing variable
 * fails the step that needs it) and travels only in the Authorization header, only to `api`.
 *
 * With `options.rateLimit`, a call GitHub refuses for a rate limit (a 403 or 429 with
 * `retry-after`, `x-ratelimit-remaining: 0` or a rate-limit message), even one whose status
 * is in `allow`, waits the time GitHub states within the policy and is sent again. A write
 * GitHub refused for a rate limit was not applied, so resending it creates nothing twice.
 * Past the policy, the call throws `GitHubError` with the status, GitHub's message, "rate
 * limit" and the reset time.
 *
 * Every other error throws at once, without a retry: every caller converges idempotently
 * and the next run redoes it.
 */
export function createGitHub(
  token: () => string,
  fetchFn: typeof fetch = fetch,
  api = 'https://api.github.com',
  options: GitHubOptions = {},
): GitHub {
  const { rateLimit, sleep = realSleep, now = Date.now, log = () => {} } = options;
  let waitedMs = 0;
  const headers = (extra: Record<string, string> = {}) => ({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token()}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nibfin-e2e',
    ...extra,
  });
  /**
   * Waits out a rate-limit refusal and returns true, throws when the policy forbids the
   * wait, or returns false for any other response. `path` is the caller's API path: never a
   * cursor or redirect URL, and never the token.
   */
  async function pace(method: string, path: string, res: Response, message: string, attempt: number): Promise<boolean> {
    if (!rateLimit) return false;
    const limit = rateLimitOf(res, message, attempt, now());
    if (!limit) return false;
    if (
      limit.waitMs > rateLimit.maxWaitMs ||
      attempt >= rateLimit.maxRetries ||
      (rateLimit.maxTotalWaitMs !== undefined && waitedMs + limit.waitMs > rateLimit.maxTotalWaitMs)
    ) {
      throw new GitHubError(method, path, res.status, `${message} (rate limit, ${limit.kind}; resets at ${limit.resetAt})`);
    }
    log(
      `GitHub ${method} ${path} hit the ${limit.kind} rate limit; waiting ${Math.ceil(limit.waitMs / 1000)} s until ${limit.resetAt} (retry ${attempt + 1}/${rateLimit.maxRetries})`,
    );
    waitedMs += limit.waitMs;
    await sleep(limit.waitMs);
    return true;
  }
  async function call(method: string, path: string, body: unknown, allow: number[]) {
    return callUrl(method, api + path, path, body, allow);
  }
  async function callUrl(method: string, url: string, path: string, body: unknown, allow: number[]) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(url, {
        method,
        headers: headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const m = (data as { message?: unknown } | undefined)?.message;
        const message = typeof m === 'string' ? m : text.slice(0, 500);
        // Before `allow`: a rate-limit refusal is never handed back as the answer.
        if (await pace(method, path, res, message, attempt)) continue;
        if (!allow.includes(res.status)) throw new GitHubError(method, path, res.status, message);
      }
      return { status: res.status, data, link: res.headers.get('link') ?? '' };
    }
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
      let res: Response;
      // Only the API step is paced; the redirected download does not go to the API host.
      for (let attempt = 0; ; attempt++) {
        res = await fetchFn(api + path, { method: 'GET', headers: headers(), redirect: 'manual' });
        if (res.status !== 403 && res.status !== 429) break;
        const text = await res.clone().text();
        let message = text.slice(0, 500);
        try {
          const m = (JSON.parse(text) as { message?: unknown } | null)?.message;
          if (typeof m === 'string') message = m;
        } catch {
          // A plain-text body keeps its first 500 characters.
        }
        if (!(await pace('GET', path, res, message, attempt))) break;
      }
      let final = res;
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) throw new GitHubError('GET', path, res.status, 'redirect without a Location header');
        final = await fetchFn(location, { method: 'GET', headers: { 'User-Agent': 'nibfin-e2e' } });
      }
      const text = await final.text();
      if (!final.ok && !allow.includes(final.status)) {
        throw new GitHubError('GET', path, final.status, final === res ? text.slice(0, 500) : 'the redirected download failed');
      }
      return { status: final.status, text };
    },
  };
  return gh;
}
