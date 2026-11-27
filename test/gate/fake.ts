import { GitHubError } from '../../src/host/github.ts';
import type { GitHub } from '../../src/host/github.ts';

export interface FakeIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string;
  labels: string[];
  assignees: string[];
  pull_request?: boolean;
  updated_at: string;
  comments: { body: string; user: string; updated_at: string; html_url: string }[];
}

export interface FakeJob {
  name: string;
  status: string;
  conclusion: string | null;
  runner_name: string | null;
  html_url: string;
  steps?: { name: string; conclusion: string | null }[];
}

export interface FakePull {
  number: number;
  head: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  base: string;
  files: { filename: string; status: string; previous_filename?: string }[];
}

/**
 * In-memory GitHub for the gate: Issues, comments, runs and jobs per repository. It records
 * every write and can throw before any call (`crash`) to simulate an interrupted run.
 */
export class FakeGate implements GitHub {
  login = 'taco3064';
  issues = new Map<string, FakeIssue[]>();
  runs = new Map<string, { created_at: string; run_attempt: number }>();
  jobs = new Map<string, FakeJob[]>();
  /** Pull requests per repository; every repository's default branch is `main`. */
  pulls = new Map<string, FakePull[]>();
  writes: string[] = [];
  reads: string[] = [];
  /** Throws before the call whose "METHOD path" (without query) matches, once. */
  crash?: { at: string; after?: number };
  /** Applied to a created Issue: simulates GitHub silently dropping labels or assignees. */
  dropOnCreate?: { labels?: boolean; assignees?: boolean };
  /** Runs after a matching write succeeds, for example to close an Issue meanwhile. */
  afterWrite?: (method: string, path: string) => void;
  clock = Date.parse('2026-11-27T10:00:00Z');
  private seen = 0;

  repo(name: string): FakeIssue[] {
    let list = this.issues.get(name);
    if (!list) this.issues.set(name, (list = []));
    return list;
  }

  addIssue(repo: string, issue: Partial<FakeIssue> & { title: string }): FakeIssue {
    const list = this.repo(repo);
    const full: FakeIssue = {
      number: list.length + 1,
      state: 'open',
      body: '',
      labels: [],
      assignees: [],
      comments: [],
      updated_at: this.now(),
      ...issue,
    };
    list.push(full);
    return full;
  }

  addPull(repo: string, pull: Partial<FakePull> & { number: number; head: string }): FakePull {
    const full: FakePull = { state: 'closed', merged_at: '2026-11-27T08:00:00Z', base: 'main', files: [], ...pull };
    let list = this.pulls.get(repo);
    if (!list) this.pulls.set(repo, (list = []));
    list.push(full);
    return full;
  }

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private view(repo: string, i: FakeIssue) {
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      body: i.body,
      html_url: `https://github.com/${repo}/issues/${i.number}`,
      labels: i.labels.map((name) => ({ name })),
      assignees: i.assignees.map((login) => ({ login })),
      updated_at: i.updated_at,
      ...(i.pull_request ? { pull_request: {} } : {}),
    };
  }

  private route(method: string, full: string, body: Record<string, unknown> | undefined): unknown {
    const url = new URL('https://api.example' + full);
    const path = url.pathname;
    const q = url.searchParams;
    const key = `${method} ${path}`;
    if (method === 'GET') this.reads.push(full);
    if (this.crash && this.crash.at === key) {
      if ((this.crash.after ?? 0) <= this.seen++) {
        this.crash = undefined;
        throw new Error(`simulated crash before ${key}`);
      }
    }
    if (key === 'GET /user') return { login: this.login };
    let m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(\/jobs)?$/.exec(path);
    if (m && method === 'GET') {
      const run = this.runs.get(m[2] as string);
      if (!run) throw new GitHubError(method, path, 404, 'Not Found');
      return m[3] ? { total_count: 0, jobs: this.jobs.get(m[2] as string) ?? [] } : run;
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+)\/files)?$/.exec(path);
    if (m && method === 'GET') {
      const repo = m[1] as string;
      const list = this.pulls.get(repo) ?? [];
      if (m[2]) {
        const pull = list.find((p) => p.number === Number(m?.[2]));
        if (!pull) throw new GitHubError(method, path, 404, 'Not Found');
        return pull.files;
      }
      const state = q.get('state') ?? 'open';
      const head = q.get('head');
      const owner = repo.split('/')[0];
      return list
        .filter((p) => (state === 'all' || p.state === state) && (!head || head === `${owner}:${p.head}`))
        .map((p) => ({ number: p.number, html_url: `https://github.com/${repo}/pull/${p.number}`, state: p.state, merged_at: p.merged_at, base: { ref: p.base, repo: { default_branch: 'main' } } }));
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+))?(\/comments)?$/.exec(path);
    if (!m) throw new GitHubError(method, path, 404, 'Not Found');
    const repo = m[1] as string;
    const list = this.repo(repo);
    const n = m[2] ? Number(m[2]) : undefined;
    const issue = n === undefined ? undefined : list.find((i) => i.number === n);
    if (n !== undefined && !issue) throw new GitHubError(method, path, 404, 'Not Found');
    if (method !== 'GET') this.writes.push(`${method} ${path}`);
    if (method === 'GET' && n === undefined) {
      const state = q.get('state') ?? 'open';
      const labels = (q.get('labels') ?? '').split(',').filter(Boolean);
      let out = list.filter((i) => (state === 'all' || i.state === state) && labels.every((l) => i.labels.includes(l)));
      if (q.get('sort') === 'updated') out = [...out].sort((a, b) => (q.get('direction') === 'asc' ? 1 : -1) * a.updated_at.localeCompare(b.updated_at));
      else out = [...out].sort((a, b) => b.number - a.number);
      return out.map((i) => this.view(repo, i));
    }
    if (method === 'GET' && issue && !m[3]) return this.view(repo, issue);
    if (method === 'GET' && issue && m[3]) {
      const since = q.get('since');
      return issue.comments.filter((c) => !since || c.updated_at >= since).map((c) => ({ body: c.body, user: { login: c.user }, html_url: c.html_url, updated_at: c.updated_at }));
    }
    if (method === 'POST' && n === undefined) {
      const created = this.addIssue(repo, {
        title: body?.title as string,
        body: body?.body as string,
        labels: this.dropOnCreate?.labels ? [] : (body?.labels as string[]),
        assignees: this.dropOnCreate?.assignees ? [] : (body?.assignees as string[]),
      });
      return this.view(repo, created);
    }
    if (method === 'POST' && issue && m[3]) {
      const c = { body: body?.body as string, user: this.login, updated_at: this.now(), html_url: `https://github.com/${repo}/issues/${issue.number}#c${issue.comments.length + 1}` };
      issue.comments.push(c);
      issue.updated_at = c.updated_at;
      return c;
    }
    if (method === 'PATCH' && issue) {
      if (typeof body?.body === 'string') issue.body = body.body;
      issue.updated_at = this.now();
      return this.view(repo, issue);
    }
    throw new GitHubError(method, path, 404, 'Not Found');
  }

  async rest<T>(method: string, path: string, body?: unknown) {
    const data = this.route(method, path, body as Record<string, unknown> | undefined);
    if (method !== 'GET') this.afterWrite?.(method, path);
    const url = new URL('https://api.example' + path);
    const page = Number(url.searchParams.get('page') ?? '1');
    if (Array.isArray(data) && url.searchParams.has('per_page')) {
      const per = Number(url.searchParams.get('per_page'));
      return { status: 200, data: data.slice((page - 1) * per, page * per) as T };
    }
    return { status: 200, data: data as T };
  }

  async list<T>(path: string, key?: string) {
    const data = this.route('GET', path, undefined);
    const items = key ? (data as Record<string, unknown>)[key] : data;
    if (!Array.isArray(items)) throw new Error(`GitHub GET ${path}: expected a list`);
    return items as T[];
  }

  async listByLink<T>(): Promise<T[]> {
    throw new Error('not used by the gate');
  }

  async graphql<T>(): Promise<T> {
    throw new Error('not used by the gate');
  }

  async download(): Promise<{ status: number; text: string }> {
    throw new Error('not used by the gate');
  }
}
