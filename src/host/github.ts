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
  graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T>;
}

/**
 * REST and GraphQL on native fetch. The token is read per call (so a missing variable
 * fails the step that needs it) and travels only in the Authorization header.
 * No retries: every caller converges idempotently and the next run redoes it.
 */
export function createGitHub(token: () => string, fetchFn: typeof fetch = fetch, api = 'https://api.github.com'): GitHub {
  async function call(method: string, path: string, body: unknown, allow: number[]) {
    const res = await fetchFn(api + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nibfin-e2e',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
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
    return { status: res.status, data };
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
    async graphql<T>(query: string, variables: Record<string, unknown>) {
      const { data } = await call('POST', '/graphql', { query, variables }, []);
      const d = data as { data?: T; errors?: { message: string }[] };
      if (d.errors?.length) throw new Error(`GitHub GraphQL: ${d.errors.map((e) => e.message).join('; ')}`);
      return d.data as T;
    },
  };
  return gh;
}
