import { treeSha } from '../../src/host/sandbox.ts';
import type { Exec, ExecOptions, ExecResult } from '../../src/host/exec.ts';
import type { HostContext } from '../../src/types.ts';

export interface FakeRepo {
  settings: Record<string, unknown>;
  branches: Map<string, string>;
  commits: Map<string, { tree: string; parents: string[] }>;
  pulls: { number: number; state: string; head: { sha: string }; files?: { filename: string; status: string; content: string }[] }[];
  issues: { number: number; node_id: string }[];
  labels: string[];
  secrets: string[];
  variables: string[];
  keys: { id: number; title: string }[];
  runners: { id: number; name: string; status: string }[];
  /** `'upgrade'` answers the rules API with GitHub's 403 for free private repositories. */
  rulesets: { id: number; name: string }[] | 'upgrade';
  /** Paths present on main (for the init read-back). */
  mainFiles: Set<string>;
}

export function cleanRepo(visibility: string, tree: string): FakeRepo {
  return {
    settings: {
      visibility,
      default_branch: 'main',
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
      delete_branch_on_merge: false,
      pull_request_creation_policy: 'collaborators_only',
    },
    branches: new Map([['main', 'c0']]),
    commits: new Map([['c0', { tree, parents: [] }]]),
    pulls: [],
    issues: [],
    labels: [],
    secrets: [],
    variables: [],
    keys: [],
    runners: [],
    rulesets: [],
    mainFiles: new Set(),
  };
}

/** A GitHub REST/GraphQL fake behind `fetch`. Records every write as "METHOD path". */
export class FakeGitHub {
  repos = new Map<string, FakeRepo>();
  writes: string[] = [];
  auth: string[] = [];
  urls: string[] = [];
  /** "METHOD path" answered with this status and no effect (a 2xx status fakes a write that does not stick). */
  failures = new Map<string, number>();
  private n = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.urls.push(url.toString());
    this.auth.push(new Headers(init?.headers).get('authorization') ?? '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = decodeURIComponent(url.pathname);
    if (method !== 'GET') this.writes.push(`${method} ${path}`);
    const fail = this.failures.get(`${method} ${path}`);
    if (fail) return json(fail, fail < 300 ? {} : { message: 'refused by fake' });
    const out = this.route(method, path, url.searchParams, body);
    if (Array.isArray(out.data) || (out.key && out.data)) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const per = Number(url.searchParams.get('per_page') ?? '30');
      const items = (out.key ? (out.data as Record<string, unknown[]>)[out.key] : out.data) as unknown[];
      const slice = items.slice((page - 1) * per, page * per);
      return json(out.status, out.key ? { total_count: items.length, [out.key]: slice } : slice);
    }
    return json(out.status, out.data);
  };

  private route(method: string, path: string, q: URLSearchParams, body: Record<string, unknown> | undefined): { status: number; data: unknown; key?: string } {
    if (path === '/graphql') {
      const id = (body?.variables as { id: string }).id;
      for (const repo of this.repos.values()) repo.issues = repo.issues.filter((i) => i.node_id !== id);
      return { status: 200, data: { data: { deleteIssue: { clientMutationId: null } } } };
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    const repo = m && this.repos.get(m[1] as string);
    if (!m || !repo) return { status: 404, data: { message: 'Not Found' } };
    const rest = m[2] ?? '';
    const ok = (data: unknown, key?: string) => ({ status: 200, data, key });
    const del = <T>(list: T[], match: (t: T) => boolean) => {
      const i = list.findIndex(match);
      if (i < 0) return { status: 404, data: { message: 'Not Found' } };
      list.splice(i, 1);
      return { status: 204, data: undefined };
    };
    let x: RegExpExecArray | null;
    if (rest === '') return method === 'PATCH' ? (Object.assign(repo.settings, body), ok(repo.settings)) : ok(repo.settings);
    if (rest === '/branches/main') {
      const sha = repo.branches.get('main');
      if (!sha) return { status: 404, data: { message: 'Branch not found' } };
      return ok({ commit: { sha, commit: { tree: { sha: repo.commits.get(sha)?.tree } } } });
    }
    if (rest === '/branches') return ok([...repo.branches.keys()].map((name) => ({ name })));
    if (rest === '/issues') {
      const prs = repo.pulls.map((p) => ({ number: p.number, node_id: `PR${p.number}`, pull_request: {} }));
      return ok([...repo.issues, ...prs]);
    }
    if (rest === '/pulls' && method === 'GET') return ok(repo.pulls.filter((p) => p.state === q.get('state')).map(({ number, head }) => ({ number, head })));
    if ((x = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = repo.pulls.find((p) => p.number === Number(x?.[1]));
      if (pr) pr.state = String(body?.state);
      return ok(pr);
    }
    if ((x = /^\/pulls\/(\d+)\/files$/.exec(rest))) {
      return ok(repo.pulls.find((p) => p.number === Number(x?.[1]))?.files?.map(({ filename, status }) => ({ filename, status })) ?? []);
    }
    if ((x = /^\/pulls\/(\d+)\/merge$/.exec(rest))) {
      const pr = repo.pulls.find((p) => p.number === Number(x?.[1]));
      if (!pr || body?.merge_method !== 'rebase' || body.sha !== pr.head.sha) return { status: 405, data: { message: 'not mergeable' } };
      pr.state = 'closed';
      for (const f of pr.files ?? []) repo.mainFiles.add(f.filename);
      return ok({ merged: true });
    }
    if ((x = /^\/contents\/(.+)$/.exec(rest))) {
      const file = x[1] as string;
      if (q.get('ref') === 'main') return repo.mainFiles.has(file) ? ok({ content: '' }) : { status: 404, data: { message: 'Not Found' } };
      const f = repo.pulls.flatMap((p) => (p.head.sha === q.get('ref') ? (p.files ?? []) : [])).find((ff) => ff.filename === file);
      return f ? ok({ content: Buffer.from(f.content).toString('base64') }) : { status: 404, data: { message: 'Not Found' } };
    }
    if ((x = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = x[1] as string;
      if (method === 'DELETE') return repo.branches.delete(name) ? { status: 204, data: undefined } : { status: 422, data: { message: 'Reference does not exist' } };
      const target = repo.commits.get(String(body?.sha));
      if (body?.force !== false || !target?.parents.includes(repo.branches.get(name) ?? '')) return { status: 422, data: { message: 'Update is not a fast forward' } };
      repo.branches.set(name, String(body?.sha));
      return ok({});
    }
    if (rest === '/git/trees') {
      const entries = (body?.tree as { path: string; content: string }[]).map((e) => ({ path: e.path, content: Buffer.from(e.content) }));
      return { status: 201, data: { sha: treeSha(entries) } };
    }
    if (rest === '/git/commits') {
      const sha = `c${++this.n}`;
      repo.commits.set(sha, { tree: String(body?.tree), parents: body?.parents as string[] });
      return { status: 201, data: { sha } };
    }
    if (rest === '/labels') return ok(repo.labels.map((name) => ({ name })));
    if ((x = /^\/labels\/(.+)$/.exec(rest))) return del(repo.labels, (l) => l === x?.[1]);
    if (rest === '/actions/secrets') return ok({ secrets: repo.secrets.map((name) => ({ name })) }, 'secrets');
    if ((x = /^\/actions\/secrets\/(.+)$/.exec(rest))) return del(repo.secrets, (s) => s === x?.[1]);
    if (rest === '/actions/variables') return ok({ variables: repo.variables.map((name) => ({ name })) }, 'variables');
    if ((x = /^\/actions\/variables\/(.+)$/.exec(rest))) return del(repo.variables, (s) => s === x?.[1]);
    if (rest === '/keys') return ok(repo.keys);
    if ((x = /^\/keys\/(\d+)$/.exec(rest))) return del(repo.keys, (k) => k.id === Number(x?.[1]));
    if (rest === '/actions/runners') return ok({ runners: repo.runners }, 'runners');
    if ((x = /^\/actions\/runners\/(\d+)$/.exec(rest))) return del(repo.runners, (r) => r.id === Number(x?.[1]));
    if (rest === '/rulesets') {
      if (repo.rulesets === 'upgrade') return { status: 403, data: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } };
      return ok(repo.rulesets);
    }
    if ((x = /^\/rulesets\/(\d+)$/.exec(rest)) && Array.isArray(repo.rulesets)) return del(repo.rulesets, (r) => r.id === Number(x?.[1]));
    return { status: 404, data: { message: `fake: no route ${method} ${rest}` } };
  }
}

function json(status: number, data: unknown): Response {
  return new Response(status === 204 || data === undefined ? null : JSON.stringify(data), { status });
}

export interface Call {
  argv: string[];
  options: ExecOptions;
}

/** Records every call; `respond` answers by the joined argv (first match by prefix). */
export function fakeExec(respond: (argv: string[], options: ExecOptions) => Partial<ExecResult> | undefined = () => undefined) {
  const calls: Call[] = [];
  const exec: Exec = async (argv, options = {}) => {
    calls.push({ argv, options });
    return { code: 0, stdout: '', stderr: '', ...respond(argv, options) };
  };
  return { exec, calls };
}

export const fakeHostContext: HostContext = {
  sandbox: { execution: 'o/exec', peer: 'o/peer' },
  executionDir: '/tmp/none',
  ghNibfin: async () => ({ code: 0, stdout: '', stderr: '' }),
  github: {
    rest: async () => {
      throw new Error('no GitHub in this test');
    },
    list: async () => [],
    graphql: async () => {
      throw new Error('no GitHub in this test');
    },
  },
  withExecutionVisibility: async (_v, fn) => fn(),
};
