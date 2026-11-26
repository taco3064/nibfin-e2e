export class GitHubError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, message: string) {
    super(`GitHub ${method} ${path} returned ${status}: ${message}`);
    this.status = status;
  }
}

export interface GitHub {
  /** One REST call. Statuses listed in `allow` are returned instead of thrown. */
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

/**
 * REST and GraphQL on native fetch. The token is read per call (so a missing variable
 * fails the step that needs it) and travels only in the Authorization header.
 * No retries: every caller converges idempotently and the next run redoes it.
 */
export function createGitHub(token: () => string, fetchFn: typeof fetch = fetch, api = 'https://api.github.com'): GitHub {
  const headers = (extra: Record<string, string> = {}) => ({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token()}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nibfin-e2e',
    ...extra,
  });
  async function call(method: string, path: string, body: unknown, allow: number[]) {
    return callUrl(method, api + path, path, body, allow);
  }
  async function callUrl(method: string, url: string, path: string, body: unknown, allow: number[]) {
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
    if (!res.ok && !allow.includes(res.status)) {
      const message = (data as { message?: unknown } | undefined)?.message;
      throw new GitHubError(method, path, res.status, typeof message === 'string' ? message : text.slice(0, 500));
    }
    return { status: res.status, data, link: res.headers.get('link') ?? '' };
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
      const res = await fetchFn(api + path, { method: 'GET', headers: headers(), redirect: 'manual' });
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
