import { createHash } from 'node:crypto';
import { treeSha } from '../../src/host/sandbox.ts';
import type { Exec, ExecOptions, ExecResult, Running, Start, StartOptions } from '../../src/host/exec.ts';
import type { HostContext } from '../../src/types.ts';

export interface FakeRepo {
  settings: Record<string, unknown>;
  branches: Map<string, string>;
  commits: Map<string, { tree: string; parents: string[] }>;
  pulls: { number: number; state: string; head: { sha: string; ref?: string }; merged?: boolean; files?: { filename: string; status: string; content: string }[] }[];
  issues: { number: number; node_id: string; state?: string; state_reason?: string; title?: string; labels?: string[]; comments?: string[] }[];
  labels: string[];
  secrets: string[];
  variables: string[];
  /** Values of `variables` by name (missing means ''). */
  variableValues: Map<string, string>;
  keys: { id: number; title: string }[];
  runners: { id: number; name: string; status: string; busy?: boolean }[];
  /** `'upgrade'` answers the rules API with GitHub's 403 for free private repositories. */
  rulesets: { id: number; name: string; rules?: { type: string }[] }[] | 'upgrade';
  tags: string[];
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
    variableValues: new Map(),
    keys: [],
    runners: [],
    rulesets: [],
    tags: [],
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
  /** Trees by sha: path → mode and content. Trees built with `base_tree` start from one of these. */
  trees = new Map<string, Map<string, { mode: string; content: string }>>();
  /** Every GET path, decoded. */
  reads: string[] = [];
  private n = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.urls.push(url.toString());
    this.auth.push(new Headers(init?.headers).get('authorization') ?? '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = decodeURIComponent(url.pathname);
    if (method !== 'GET') this.writes.push(`${method} ${path}`);
    else this.reads.push(path);
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
    if (rest === '/issues' && method === 'POST') {
      const number = 1000 + ++this.n;
      repo.issues.push({ number, node_id: `I${number}`, state: 'open', title: String(body?.title), labels: [...((body?.labels as string[]) ?? [])], comments: [] });
      return { status: 201, data: { number } };
    }
    if (rest === '/issues') {
      const state = q.get('state') ?? 'open';
      const prs = repo.pulls.filter((p) => state === 'all' || p.state === state).map((p) => ({ number: p.number, node_id: `PR${p.number}`, pull_request: {} }));
      const issues = repo.issues.filter((i) => state === 'all' || (i.state ?? 'open') === state).map(({ number, node_id }) => ({ number, node_id }));
      return ok([...issues, ...prs]);
    }
    if ((x = /^\/issues\/(\d+)(\/labels|\/comments)?$/.exec(rest))) {
      const issue = repo.issues.find((i) => i.number === Number(x?.[1]));
      if (!issue) return { status: 404, data: { message: 'Not Found' } };
      if (x[2] === '/labels') {
        if (method === 'POST') issue.labels = [...new Set([...(issue.labels ?? []), ...((body?.labels as string[]) ?? [])])];
        return ok((issue.labels ?? []).map((name) => ({ name })));
      }
      // Comments are the Owner's, as Nibfin writes with the Owner's credential.
      if (x[2] === '/comments') return ok((issue.comments ?? []).map((b) => ({ body: b, user: { login: (m?.[1] ?? '').split('/')[0] } })));
      if (method === 'PATCH') Object.assign(issue, body);
      return ok(issue);
    }
    if (rest === '/pulls' && method === 'GET') {
      const head = q.get('head');
      return ok(repo.pulls.filter((p) => (q.get('state') === 'all' || p.state === q.get('state')) && (!head || head.endsWith(`:${p.head.ref}`))).map(({ number, head: h }) => ({ number, head: h })));
    }
    if ((x = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = repo.pulls.find((p) => p.number === Number(x?.[1]));
      if (pr && method === 'PATCH') pr.state = String(body?.state);
      return pr ? ok({ ...pr, merged: pr.merged ?? false }) : { status: 404, data: { message: 'Not Found' } };
    }
    if ((x = /^\/pulls\/(\d+)\/files$/.exec(rest))) {
      return ok(repo.pulls.find((p) => p.number === Number(x?.[1]))?.files?.map(({ filename, status }) => ({ filename, status })) ?? []);
    }
    if ((x = /^\/pulls\/(\d+)\/merge$/.exec(rest))) {
      const pr = repo.pulls.find((p) => p.number === Number(x?.[1]));
      if (!pr || body?.merge_method !== 'rebase' || body.sha !== pr.head.sha) return { status: 405, data: { message: 'not mergeable' } };
      pr.state = 'closed';
      for (const f of pr.files ?? []) repo.mainFiles.add(f.filename);
      const merged = `merge${pr.number}`;
      repo.commits.set(merged, { tree: `tree-${merged}`, parents: [repo.branches.get('main') ?? ''] });
      repo.branches.set('main', merged);
      return ok({ merged: true });
    }
    if ((x = /^\/contents\/(.+)$/.exec(rest))) {
      const file = x[1] as string;
      if (q.get('ref') === 'main') return repo.mainFiles.has(file) ? ok({ content: '' }) : { status: 404, data: { message: 'Not Found' } };
      const f = repo.pulls.flatMap((p) => (p.head.sha === q.get('ref') ? (p.files ?? []) : [])).find((ff) => ff.filename === file);
      return f ? ok({ content: Buffer.from(f.content).toString('base64') }) : { status: 404, data: { message: 'Not Found' } };
    }
    if (rest === '/git/matching-refs/tags') return ok(repo.tags.map((t) => ({ ref: `refs/tags/${t}` })));
    if ((x = /^\/git\/refs\/tags\/(.+)$/.exec(rest)) && method === 'DELETE') return del(repo.tags, (t) => t === x?.[1]);
    if ((x = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = x[1] as string;
      if (method === 'DELETE') return repo.branches.delete(name) ? { status: 204, data: undefined } : { status: 422, data: { message: 'Reference does not exist' } };
      const target = repo.commits.get(String(body?.sha));
      const pr = Array.isArray(repo.rulesets) && repo.rulesets.find((r) => r.rules?.some((rule) => rule.type === 'pull_request'));
      if (name === 'main' && pr) return { status: 422, data: { message: `Repository rule violations found: changes must be made through a pull request (${pr.name})` } };
      if (body?.force !== false || !target?.parents.includes(repo.branches.get(name) ?? '')) return { status: 422, data: { message: 'Update is not a fast forward' } };
      repo.branches.set(name, String(body?.sha));
      return ok({});
    }
    if ((x = /^\/git\/trees\/(.+)$/.exec(rest)) && method === 'GET') {
      const commit = repo.commits.get(repo.branches.get(x[1] as string) ?? '');
      const files = this.trees.get(commit?.tree ?? '');
      return files ? ok({ tree: [...files.keys()].map((path) => ({ path })) }) : { status: 404, data: { message: 'Not Found' } };
    }
    if (rest === '/git/trees') {
      const baseSha = body?.base_tree as string | undefined;
      const base = baseSha === undefined ? new Map() : this.trees.get(baseSha);
      if (!base) return { status: 422, data: { message: 'base_tree is not a tree' } };
      const files = new Map(base);
      for (const e of body?.tree as { path: string; mode: string; content: string }[]) files.set(e.path, { mode: e.mode, content: e.content });
      const sha = fakeTreeSha(files);
      this.trees.set(sha, files);
      return { status: 201, data: { sha } };
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
    if (rest === '/actions/variables' && method === 'POST') {
      if (repo.variables.includes(String(body?.name))) return { status: 409, data: { message: 'Already exists' } };
      repo.variables.push(String(body?.name));
      repo.variableValues.set(String(body?.name), String(body?.value));
      return { status: 201, data: {} };
    }
    if (rest === '/actions/variables') return ok({ variables: repo.variables.map((name) => ({ name, value: repo.variableValues.get(name) ?? '' })) }, 'variables');
    if ((x = /^\/actions\/variables\/(.+)$/.exec(rest)) && method === 'PATCH') {
      if (!repo.variables.includes(x[1] as string)) return { status: 404, data: { message: 'Not Found' } };
      repo.variableValues.set(x[1] as string, String(body?.value));
      return { status: 204, data: undefined };
    }
    if ((x = /^\/actions\/variables\/(.+)$/.exec(rest))) return del(repo.variables, (s) => s === x?.[1]);
    if (rest === '/keys') return ok(repo.keys);
    if ((x = /^\/keys\/(\d+)$/.exec(rest))) return del(repo.keys, (k) => k.id === Number(x?.[1]));
    if (rest === '/actions/runners') return ok({ runners: repo.runners }, 'runners');
    if ((x = /^\/actions\/runners\/(\d+)$/.exec(rest))) return del(repo.runners, (r) => r.id === Number(x?.[1]));
    if (rest === '/rulesets') {
      if (repo.rulesets === 'upgrade') return { status: 403, data: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } };
      if (method === 'POST') {
        const created = { id: 500 + ++this.n, name: String(body?.name), rules: body?.rules as { type: string }[] };
        repo.rulesets.push(created);
        return { status: 201, data: created };
      }
      return ok(repo.rulesets);
    }
    if ((x = /^\/rulesets\/(\d+)$/.exec(rest)) && Array.isArray(repo.rulesets)) return del(repo.rulesets, (r) => r.id === Number(x?.[1]));
    return { status: 404, data: { message: `fake: no route ${method} ${rest}` } };
  }
}

/** The tree sha the fake gives: git's own for regular files only, otherwise a stable stand-in. */
function fakeTreeSha(files: Map<string, { mode: string; content: string }>): string {
  const list = [...files].sort(([a], [b]) => (a < b ? -1 : 1));
  if (list.every(([, f]) => f.mode === '100644')) return treeSha(list.map(([path, f]) => ({ path, content: Buffer.from(f.content) })));
  return 'L' + createHash('sha1').update(JSON.stringify(list)).digest('hex');
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

/** A started child that prints `output` at once and records when it is stopped. */
export function fakeRunning(output = ''): Running & { stops: number } {
  const r = {
    stops: 0,
    output: () => output,
    waitFor: async (pattern: RegExp) => {
      const m = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(output);
      if (!m) throw new Error(`fake child printed no ${pattern}`);
      return m;
    },
    stop: async () => {
      r.stops++;
      return { code: 0, stdout: output, stderr: '' };
    },
  };
  return r;
}

/** Records every start; `respond` gives the output of each child. */
export function fakeStart(respond: (argv: string[], options: StartOptions) => string = () => '') {
  const started: { argv: string[]; options: StartOptions; child: ReturnType<typeof fakeRunning> }[] = [];
  const start: Start = (argv, options = {}) => {
    const child = fakeRunning(respond(argv, options));
    started.push({ argv, options, child });
    return child;
  };
  return { start, started };
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
    listByLink: async () => [],
    graphql: async () => {
      throw new Error('no GitHub in this test');
    },
    download: async () => {
      throw new Error('no GitHub in this test');
    },
  },
  withExecutionVisibility: async (_v, fn) => fn(),
  startGhNibfin: () => fakeRunning(),
  start: () => fakeRunning(),
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  workDir: () => '/tmp/none',
  browserEnv: () => ({}),
  claudeLogin: async () => 'no host in this test',
  runnerServices: async () => [],
  stopJobContainers: async () => 0,
  secretValues: () => [],
  ownerLogin: async () => 'owner',
  ownerId: async () => 1,
};
