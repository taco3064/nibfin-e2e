import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Visibility } from './config.ts';
import { GitHubError, type GitHub } from './github.ts';

export interface TemplateFile {
  /** Path relative to the template root, with `/` separators. */
  path: string;
  content: Buffer;
}

/** Reads every file under the template directory, sorted by path. */
export function readTemplate(dir: string): TemplateFile[] {
  const out: TemplateFile[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push({ path: relative(dir, p).split(sep).join('/'), content: readFileSync(p) });
      else throw new Error(`sandbox template: ${p} is not a regular file`);
    }
  };
  walk(dir);
  if (!out.length) throw new Error(`sandbox template ${dir} is empty`);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function gitObject(type: string, body: Buffer): Buffer {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]))
    .digest();
}

/** The git tree sha of the files as regular (100644) blobs, computed locally so a clean sandbox needs no write. */
export function treeSha(files: TemplateFile[]): string {
  type Dir = Map<string, Buffer | Dir>;
  const root: Dir = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      let next = d.get(part);
      if (!(next instanceof Map)) d.set(part, (next = new Map()));
      d = next;
    }
    d.set(parts[parts.length - 1] as string, f.content);
  }
  const hash = (d: Dir): Buffer => {
    const entries = [...d].map(([name, v]) => ({ name, v, key: v instanceof Map ? name + '/' : name }));
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const body = entries.map(({ name, v }) =>
      v instanceof Map
        ? Buffer.concat([Buffer.from(`40000 ${name}\0`), hash(v)])
        : Buffer.concat([Buffer.from(`100644 ${name}\0`), gitObject('blob', v)]),
    );
    return gitObject('tree', Buffer.concat(body));
  };
  return hash(root).toString('hex');
}

const ref = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

/** Repository settings the reset converges; other settings (for example Issue creation) are left as they are. */
export function knownSettings(visibility: Visibility): Record<string, string | boolean> {
  return {
    visibility,
    default_branch: 'main',
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
    pull_request_creation_policy: 'collaborators_only',
  };
}

export interface Ruleset {
  id: number;
  name: string;
}

/** Whether a 403 message from the rules API means the plan has no rulesets (Proposal R3.55). */
export const planHasNoRulesets = (message: string): boolean => /Upgrade to GitHub Pro/i.test(message);

/** Rulesets of the repository; a private repository on a plan without rulesets has none (Proposal R3.55). */
export async function rulesets(gh: GitHub, repo: string): Promise<Ruleset[]> {
  const r = await gh.rest<Ruleset[] | { message?: string }>(
    'GET',
    `/repos/${repo}/rulesets?per_page=100`,
    undefined,
    [403],
  );
  if (r.status === 403) {
    const message = (r.data as { message?: string }).message ?? '';
    if (planHasNoRulesets(message)) return [];
    throw new Error(`GitHub GET /repos/${repo}/rulesets returned 403: ${message}`);
  }
  return r.data as Ruleset[];
}

/**
 * Classic branch protection of the branch, or undefined when it has none: GitHub answers
 * 404 for an unprotected branch (Proposal R4.39), and 403 "Upgrade to GitHub Pro" on a
 * private repository whose plan has no branch protection.
 */
export async function branchProtection(
  gh: GitHub,
  repo: string,
  branch = 'main',
): Promise<Record<string, unknown> | undefined> {
  const path = `/repos/${repo}/branches/${ref(branch)}/protection`;
  const r = await gh.rest<Record<string, unknown>>('GET', path, undefined, [403, 404]);
  if (r.status === 404) return undefined;
  if (r.status === 403) {
    const message = String((r.data as { message?: unknown } | undefined)?.message ?? '');
    if (/Upgrade to GitHub Pro/i.test(message)) return undefined;
    throw new Error(`GitHub GET ${path} returned 403: ${message}`);
  }
  return r.data;
}

interface Runner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
}

interface State {
  settings: Record<string, unknown>;
  pulls: { number: number }[];
  branches: string[];
  issues: { number: number; node_id: string }[];
  labels: string[];
  secrets: string[];
  variables: string[];
  keys: { id: number; title: string }[];
  runners: Runner[];
  rulesets: Ruleset[];
  /** main has classic branch protection. */
  protection: boolean;
  tags: string[];
  mainCommit?: string;
  mainTree?: string;
}

async function listRunners(gh: GitHub, repo: string): Promise<Runner[]> {
  const runners = await gh.list<Runner>(`/repos/${repo}/actions/runners`, 'runners');
  return runners.map(({ id, name, status, busy }) => ({ id, name, status, busy: busy === true }));
}

async function read(gh: GitHub, repo: string): Promise<State> {
  const r = `/repos/${repo}`;
  const { data: settings } = await gh.rest<Record<string, unknown>>('GET', r);
  const main = await mainHead(gh, repo);
  const issues = await gh.list<{ number: number; node_id: string; pull_request?: unknown }>(`${r}/issues?state=all`);
  return {
    settings,
    pulls: await gh.list<{ number: number }>(`${r}/pulls?state=open`),
    branches: (await gh.list<{ name: string }>(`${r}/branches`)).map((b) => b.name),
    issues: issues.filter((i) => i.pull_request === undefined),
    labels: (await gh.list<{ name: string }>(`${r}/labels`)).map((l) => l.name),
    secrets: (await gh.list<{ name: string }>(`${r}/actions/secrets`, 'secrets')).map((s) => s.name),
    variables: (await gh.list<{ name: string }>(`${r}/actions/variables`, 'variables')).map((v) => v.name),
    keys: await gh.list<{ id: number; title: string }>(`${r}/keys`),
    runners: await listRunners(gh, repo),
    rulesets: await rulesets(gh, repo),
    protection: (await branchProtection(gh, repo)) !== undefined,
    mainCommit: main?.commit,
    mainTree: main?.tree,
    // matching-refs returns every match in one answer (it is not paginated).
    tags: (await gh.rest<{ ref: string }[]>('GET', `${r}/git/matching-refs/tags`)).data.map((t) =>
      t.ref.replace(/^refs\/tags\//, ''),
    ),
  };
}

function settingsDiff(state: State, visibility: Visibility): Record<string, string | boolean> {
  const diff: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(knownSettings(visibility))) if (state.settings[k] !== v) diff[k] = v;
  return diff;
}

/** Everything that differs from the known state; an empty list means clean. */
export function differences(repo: string, state: State, visibility: Visibility, tree: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(settingsDiff(state, visibility))) {
    out.push(`${repo}: ${k} is ${JSON.stringify(state.settings[k])}, expected ${JSON.stringify(v)}`);
  }
  if (state.mainTree === undefined) out.push(`${repo}: branch main does not exist`);
  else if (state.mainTree !== tree)
    out.push(`${repo}: main's tree is ${state.mainTree}, expected the template tree ${tree}`);
  for (const p of state.pulls) out.push(`${repo}: pull request #${p.number} is open`);
  for (const b of state.branches) if (b !== 'main') out.push(`${repo}: branch ${b} exists`);
  for (const i of state.issues) out.push(`${repo}: Issue #${i.number} exists`);
  for (const l of state.labels) out.push(`${repo}: label ${l} exists`);
  for (const s of state.secrets) out.push(`${repo}: Actions secret ${s} exists`);
  for (const v of state.variables) out.push(`${repo}: Actions variable ${v} exists`);
  for (const k of state.keys) out.push(`${repo}: deploy key ${k.title} exists`);
  for (const r of state.runners) out.push(`${repo}: runner registration ${r.name} (${r.status}) exists`);
  for (const r of state.rulesets) out.push(`${repo}: ruleset ${r.name} exists`);
  if (state.protection) out.push(`${repo}: branch main has branch protection`);
  for (const t of state.tags) out.push(`${repo}: tag ${t} exists`);
  return out;
}

/** One file of a tree written through the Git Data API: a regular file, or a symlink whose content is its target. */
export interface TreeEntry {
  path: string;
  mode: '100644' | '120000';
  content: string;
}

/** Creates a tree from the entries, on top of `baseTree` when given, and returns its sha. */
export async function createTree(gh: GitHub, repo: string, entries: TreeEntry[], baseTree?: string): Promise<string> {
  const tree = entries.map((e) => ({ path: e.path, mode: e.mode, type: 'blob', content: e.content }));
  const body = baseTree === undefined ? { tree } : { base_tree: baseTree, tree };
  const { data } = await gh.rest<{ sha: string }>('POST', `/repos/${repo}/git/trees`, body);
  return data.sha;
}

/** Commits the tree on `parent` and fast-forwards main to it (`force: false`, so a moved main is refused). */
export async function commitOnMain(
  gh: GitHub,
  repo: string,
  tree: string,
  parent: string,
  message: string,
): Promise<string> {
  const r = `/repos/${repo}`;
  const { data: commit } = await gh.rest<{ sha: string }>('POST', `${r}/git/commits`, {
    message,
    tree,
    parents: [parent],
  });
  await gh.rest('PATCH', `${r}/git/refs/heads/main`, { sha: commit.sha, force: false });
  return commit.sha;
}

/** main's head commit and its tree, or undefined when main does not exist. */
export async function mainHead(gh: GitHub, repo: string): Promise<{ commit: string; tree: string } | undefined> {
  const main = await gh.rest<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(
    'GET',
    `/repos/${repo}/branches/main`,
    undefined,
    [404],
  );
  return main.status === 404 ? undefined : { commit: main.data.commit.sha, tree: main.data.commit.commit.tree.sha };
}

export interface SandboxDeps {
  github: GitHub;
  template: TemplateFile[];
  log(message: string): void;
  /** Milliseconds now; defaults to `Date.now`. Tests replace it with a fake clock. */
  now?: () => number;
  /** Waits the given milliseconds; defaults to a real timer. Tests replace it with a fake clock. */
  sleep?: (ms: number) => Promise<void>;
}

/** Workflow run statuses GitHub lists that have not completed. */
const UNFINISHED = ['queued', 'in_progress', 'waiting', 'pending', 'requested'] as const;
/** How long the reset waits for busy runner registrations to be released. */
const WAIT_MS = 360_000;
/** How often the reset reads the runner registrations again while it waits. */
const POLL_MS = 10_000;
/** After this long with a registration still busy, runs that had a plain cancel get one force-cancel. */
const FORCE_AFTER_MS = 60_000;

interface Run {
  id: number;
  name: string;
  status: string;
}

/** The sandbox's workflow runs that have not completed, one list call per status, by id. */
async function unfinishedRuns(gh: GitHub, repo: string): Promise<Run[]> {
  const runs = new Map<number, Run>();
  for (const status of UNFINISHED) {
    for (const run of await gh.list<Run>(`/repos/${repo}/actions/runs?status=${status}`, 'workflow_runs')) {
      if (!runs.has(run.id)) runs.set(run.id, { id: run.id, name: run.name, status: run.status });
    }
  }
  return [...runs.values()];
}

/** Sends a cancel (or force-cancel) for the run and logs it; a 409 (already finished) is accepted. */
async function cancelRun(deps: SandboxDeps, repo: string, run: Run, force: boolean): Promise<void> {
  const kind = force ? 'force-cancel' : 'cancel';
  const r = await deps.github.rest<{ message?: string }>(
    'POST',
    `/repos/${repo}/actions/runs/${run.id}/${kind}`,
    undefined,
    [409],
  );
  const answer = r.status === 409 ? `; GitHub answered 409: ${String(r.data?.message ?? '')}` : '';
  deps.log(`${repo}: ${kind} requested for workflow run ${run.id} (${run.name}, ${run.status})${answer}`);
}

/** The in-progress job of the sandbox that GitHub reports on the runner, if any. */
async function holder(gh: GitHub, repo: string, runner: Runner): Promise<string> {
  for (const run of await unfinishedRuns(gh, repo)) {
    if (run.status !== 'in_progress') continue;
    const jobs = await gh.list<{ name: string; status: string; runner_name: string | null; html_url: string }>(
      `/repos/${repo}/actions/runs/${run.id}/jobs`,
      'jobs',
    );
    const job = jobs.find((j) => j.status === 'in_progress' && j.runner_name === runner.name);
    if (job) return `held by job "${job.name}" (${job.html_url}) of workflow run ${run.id} (${run.name})`;
  }
  return 'no in-progress job of this repository names it';
}

const ids = (list: number[]) => (list.length ? list.join(', ') : 'none');

/**
 * Cancels the sandbox's unfinished workflow runs, waits up to WAIT_MS for no runner
 * registration to be busy, then deletes every registration. A registration GitHub still
 * refuses to delete fails the reset with the runner, the job holding it and the next step.
 */
async function releaseRunners(deps: SandboxDeps, repo: string, initial: Runner[]): Promise<void> {
  const { github: gh, log } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cancelled: number[] = [];
  const forced: number[] = [];
  for (const run of await unfinishedRuns(gh, repo)) {
    await cancelRun(deps, repo, run, false);
    cancelled.push(run.id);
  }

  let runners = initial;
  let waited = 0;
  if (runners.some((rn) => rn.busy)) {
    const start = now();
    const waitedFor = runners.filter((rn) => rn.busy).map((rn) => rn.name);
    let forceSent = false;
    while (runners.some((rn) => rn.busy) && now() - start < WAIT_MS) {
      await sleep(POLL_MS);
      runners = await listRunners(gh, repo);
      // Force-cancel once, only runs that ignored a plain cancel (GitHub reserves it for those).
      if (!forceSent && runners.some((rn) => rn.busy) && now() - start >= FORCE_AFTER_MS) {
        forceSent = true;
        for (const run of await unfinishedRuns(gh, repo)) {
          if (!cancelled.includes(run.id)) continue;
          await cancelRun(deps, repo, run, true);
          forced.push(run.id);
        }
      }
    }
    waited = now() - start;
    const busy = runners.filter((rn) => rn.busy).map((rn) => rn.name);
    log(
      `${repo}: waited ${Math.round(waited / 1000)}s for runner(s) ${waitedFor.join(', ')} to be released; ${busy.length ? `still busy: ${busy.join(', ')}` : 'released'}`,
    );
  }

  const refused: { runner: Runner; error: GitHubError }[] = [];
  for (const rn of runners) {
    const path = `/repos/${repo}/actions/runners/${rn.id}`;
    const r = await gh.rest<{ message?: string }>('DELETE', path, undefined, [422]);
    if (r.status === 422)
      refused.push({ runner: rn, error: new GitHubError('DELETE', path, 422, String(r.data?.message ?? '')) });
  }
  if (!refused.length) return;

  const parts: string[] = [];
  for (const { runner, error } of refused) {
    parts.push(
      `${repo}: runner registration ${runner.name} (id ${runner.id}) could not be deleted: ${error.message}; ${await holder(gh, repo, runner)}`,
    );
  }
  parts.push(`cancel requested for runs ${ids(cancelled)}; force-cancel for ${ids(forced)}`);
  parts.push(`waited ${Math.round(waited / 1000)}s of ${WAIT_MS / 1000}s`);
  parts.push(
    'the runner must finish its job, or its job must be cancelled or the runner released on GitHub, before the sandboxes can be reset; then rerun the sandboxes step',
  );
  throw new Error(parts.join('; '), { cause: refused[0]?.error });
}

/**
 * Converges a sandbox to the known state, writing only what differs, then reads every
 * item back. Returns the remaining differences; an empty list means clean.
 * Collaborators are never touched.
 */
export async function resetSandbox(deps: SandboxDeps, repo: string, visibility: Visibility): Promise<string[]> {
  const { github: gh, log } = deps;
  const r = `/repos/${repo}`;
  const tree = treeSha(deps.template);
  const s = await read(gh, repo);
  if (s.mainCommit === undefined)
    throw new Error(`${repo}: branch main does not exist; the sandbox must have a main branch`);

  const settings = settingsDiff(s, visibility);
  if (Object.keys(settings).length) {
    log(`${repo}: settings ${Object.keys(settings).join(', ')}`);
    await gh.rest('PATCH', r, settings);
  }
  // Both policies go before the commit on main, so neither can refuse it.
  for (const rs of s.rulesets) await gh.rest('DELETE', `${r}/rulesets/${rs.id}`);
  if (s.protection) await gh.rest('DELETE', `${r}/branches/main/protection`);
  for (const p of s.pulls) await gh.rest('PATCH', `${r}/pulls/${p.number}`, { state: 'closed' });
  for (const b of s.branches) if (b !== 'main') await gh.rest('DELETE', `${r}/git/refs/heads/${ref(b)}`);
  for (const i of s.issues) {
    await gh.graphql('mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }', {
      id: i.node_id,
    });
  }
  for (const l of s.labels) await gh.rest('DELETE', `${r}/labels/${encodeURIComponent(l)}`);
  for (const name of s.secrets) await gh.rest('DELETE', `${r}/actions/secrets/${encodeURIComponent(name)}`);
  for (const name of s.variables) await gh.rest('DELETE', `${r}/actions/variables/${encodeURIComponent(name)}`);
  for (const k of s.keys) await gh.rest('DELETE', `${r}/keys/${k.id}`);
  await releaseRunners(deps, repo, s.runners);
  for (const t of s.tags) await gh.rest('DELETE', `${r}/git/refs/tags/${ref(t)}`);

  if (s.mainTree !== tree) {
    log(`${repo}: main's tree differs from the template; adding a commit`);
    const entries = deps.template.map((f): TreeEntry => {
      const content = f.content.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(f.content))
        throw new Error(`sandbox template: ${f.path} is not UTF-8 text`);
      return { path: f.path, mode: '100644', content };
    });
    const created = await createTree(gh, repo, entries);
    if (created !== tree) throw new Error(`${repo}: GitHub built tree ${created}, expected ${tree}`);
    await commitOnMain(gh, repo, tree, s.mainCommit, 'Reset the sandbox to the nibfin-e2e template');
  }

  return differences(repo, await read(gh, repo), visibility, tree);
}

/** Names of the runner registrations GitHub reports online. */
export async function onlineRunners(gh: GitHub, repo: string): Promise<string[]> {
  const runners = await gh.list<{ name: string; status: string }>(`/repos/${repo}/actions/runners`, 'runners');
  return runners.filter((r) => r.status === 'online').map((r) => r.name);
}

/** Sets the visibility and reads it back. */
export async function setVisibility(gh: GitHub, repo: string, visibility: Visibility): Promise<void> {
  await gh.rest('PATCH', `/repos/${repo}`, { visibility });
  const { data } = await gh.rest<{ visibility?: string }>('GET', `/repos/${repo}`);
  if (data.visibility !== visibility)
    throw new Error(`${repo}: visibility reads back ${String(data.visibility)}, expected ${visibility}`);
}
