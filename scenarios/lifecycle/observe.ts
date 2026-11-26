// One shared, read-only view of the sandboxes. Waiters share a snapshot that is
// refreshed at most once per interval; detail reads are cached for the same interval,
// or for good once what they read can no longer change.
import type { GitHub } from '../../src/host/github.ts';
import { parseLog } from './analysis.ts';
import type { Activity, Comment, Issue, Job, LogLine, Pull, Run, Runner } from './analysis.ts';

export interface Snapshot {
  gen: number;
  at: number;
  /** Runs of every observed repository created since the observer started. */
  runs: Run[];
  issues: Map<string, Issue[]>;
  pulls: Map<string, Pull[]>;
}

export interface ObserverOptions {
  /** Epoch ms; runs created before it are not read. */
  since: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const DONE_JOB = (j: Job) => j.status === 'completed';
/** How far before the previous listing a refresh lists again, for runs GitHub creates late or a clock skew. */
const RELIST_MARGIN_MS = 10 * 60_000;

export class Observer {
  private gen = 0;
  private snap?: Snapshot;
  private pending?: Promise<Snapshot>;
  private lastAt?: number;
  private readonly cache = new Map<string, { gen: number; final: boolean; value: Promise<unknown> }>();
  /** Every run seen since the start, by "repo id". */
  private readonly seen = new Map<string, Run>();
  private readonly listedAt = new Map<string, number>();
  readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interval: number;

  private readonly gh: GitHub;
  private readonly repos: string[];
  private readonly opts: ObserverOptions;

  constructor(gh: GitHub, repos: string[], opts: ObserverOptions) {
    this.gh = gh;
    this.repos = repos;
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.interval = opts.intervalMs ?? 60_000;
  }

  /** A snapshot newer than generation `seen`, refreshing at most once per interval. */
  next(seen = -1): Promise<Snapshot> {
    if (this.snap && this.snap.gen > seen) return Promise.resolve(this.snap);
    this.pending ??= (async () => {
      const wait = this.lastAt === undefined ? 0 : this.lastAt + this.interval - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        const s = await this.read();
        this.snap = s;
        return s;
      } finally {
        this.lastAt = this.now();
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  /** The next snapshot after the current one (at most one interval away). */
  fresh(): Promise<Snapshot> {
    return this.next(this.snap?.gen ?? -1);
  }

  /** The current snapshot, reading one if none exists yet. */
  current(): Promise<Snapshot> {
    return this.snap ? Promise.resolve(this.snap) : this.next();
  }

  /**
   * Runs are merged across snapshots: GitHub answers a `created`-filtered run list with
   * at most 1,000 results, so each refresh lists only runs created since shortly before
   * the previous one and re-reads the runs seen earlier that had not completed.
   */
  private async readRuns(repo: string): Promise<void> {
    const r = `/repos/${repo}`;
    const from = Math.max(this.opts.since, (this.listedAt.get(repo) ?? -Infinity) - RELIST_MARGIN_MS);
    this.listedAt.set(repo, this.now());
    const iso = new Date(from).toISOString().replace(/\.\d+Z$/, 'Z');
    const listed = new Set<number>();
    for (const run of await this.gh.list<Omit<Run, 'repo'>>(`${r}/actions/runs?created=${encodeURIComponent('>=' + iso)}`, 'workflow_runs')) {
      this.seen.set(`${repo} ${run.id}`, { ...run, repo });
      listed.add(run.id);
    }
    for (const [key, run] of this.seen) {
      if (run.repo !== repo || run.status === 'completed' || listed.has(run.id)) continue;
      const { data } = await this.gh.rest<Omit<Run, 'repo'>>('GET', `${r}/actions/runs/${run.id}`);
      this.seen.set(key, { ...data, repo });
    }
  }

  private async read(): Promise<Snapshot> {
    const issues = new Map<string, Issue[]>();
    const pulls = new Map<string, Pull[]>();
    for (const repo of this.repos) {
      const r = `/repos/${repo}`;
      await this.readRuns(repo);
      issues.set(repo, (await this.gh.list<Issue>(`${r}/issues?state=all`)).filter((i) => i.pull_request === undefined));
      pulls.set(repo, await this.gh.list<Pull>(`${r}/pulls?state=all`));
    }
    const runs = [...this.seen.values()];
    const s: Snapshot = { gen: ++this.gen, at: this.now(), runs, issues, pulls };
    try {
      const { data } = await this.gh.rest<{ resources?: { core?: { remaining?: number } } }>('GET', '/rate_limit');
      this.opts.log?.(`observer: snapshot ${s.gen}, ${runs.length} runs, ${data.resources?.core?.remaining ?? '?'} requests left this hour`);
    } catch {
      // The rate limit is only logged.
    }
    return s;
  }

  /**
   * Waits until `fn` returns a value other than `undefined`. At the deadline it fails
   * naming what it waited for and, through `show`, the last observed state.
   */
  async until<T>(
    desc: string,
    fn: (s: Snapshot) => T | undefined | Promise<T | undefined>,
    timeoutMs: number,
    show?: (s: Snapshot) => string | Promise<string>,
  ): Promise<T> {
    const end = this.now() + timeoutMs;
    let seen = -1;
    for (;;) {
      const s = await this.next(seen);
      seen = s.gen;
      const v = await fn(s);
      if (v !== undefined) return v;
      if (this.now() >= end) {
        const state = show ? await show(s) : '';
        throw new Error(`timed out after ${Math.round(timeoutMs / 60_000)} min waiting for ${desc}${state ? `; observed: ${state}` : ''}`);
      }
    }
  }

  /** Caches `fn` for this snapshot generation, or for good once `final` says the value can no longer change. */
  private memo<T>(key: string, fn: () => Promise<T>, final: (v: T) => boolean = () => false): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && (hit.final || hit.gen === this.gen)) return hit.value as Promise<T>;
    const entry = { gen: this.gen, final: false, value: fn() as Promise<unknown> };
    this.cache.set(key, entry);
    entry.value.then(
      (v) => (entry.final = final(v as T)),
      () => this.cache.delete(key),
    );
    return entry.value as Promise<T>;
  }

  /** Every job of every attempt of a run. */
  jobs(repo: string, runId: number): Promise<Job[]> {
    return this.memo(`jobs ${repo} ${runId}`, () => this.gh.list<Job>(`/repos/${repo}/actions/runs/${runId}/jobs?filter=all`, 'jobs'), (js) => js.length > 0 && js.every(DONE_JOB));
  }

  job(repo: string, jobId: number): Promise<Job> {
    return this.memo(`job ${repo} ${jobId}`, async () => (await this.gh.rest<Job>('GET', `/repos/${repo}/actions/jobs/${jobId}`)).data, DONE_JOB);
  }

  /** A completed job's log, line by line. */
  log(repo: string, jobId: number): Promise<LogLine[]> {
    return this.memo(`log ${repo} ${jobId}`, async () => parseLog(await this.gh.text(`/repos/${repo}/actions/jobs/${jobId}/logs`)), () => true);
  }

  comments(repo: string, n: number): Promise<Comment[]> {
    return this.memo(`comments ${repo} ${n}`, () => this.gh.list<Comment>(`/repos/${repo}/issues/${n}/comments`));
  }

  /** Repository activity (push, force_push, branch_creation, branch_deletion…), optionally for one ref. */
  activity(repo: string, filter: { ref?: string; type?: string } = {}): Promise<Activity[]> {
    const q = [filter.ref && `ref=${encodeURIComponent(filter.ref)}`, filter.type && `activity_type=${filter.type}`].filter(Boolean).join('&');
    return this.memo(`activity ${repo} ${q}`, () => this.gh.list<Activity>(`/repos/${repo}/activity${q ? `?${q}` : ''}`));
  }

  blockedBy(repo: string, n: number): Promise<Issue[]> {
    return this.memo(`blocked_by ${repo} ${n}`, () => this.gh.list<Issue>(`/repos/${repo}/issues/${n}/dependencies/blocked_by`));
  }

  checkRuns(repo: string, sha: string): Promise<{ name: string; status: string; conclusion: string | null; completed_at: string | null }[]> {
    return this.memo(`checks ${repo} ${sha}`, () => this.gh.list(`/repos/${repo}/commits/${sha}/check-runs`, 'check_runs'));
  }

  timeline(repo: string, n: number): Promise<{ event: string; created_at: string; label?: { name: string } }[]> {
    return this.memo(`timeline ${repo} ${n}`, () => this.gh.list(`/repos/${repo}/issues/${n}/timeline`));
  }

  runners(repo: string): Promise<Runner[]> {
    return this.memo(`runners ${repo}`, () => this.gh.list<Runner>(`/repos/${repo}/actions/runners`, 'runners'));
  }

  /** Every PR, open or closed, whose head is the branch. */
  pullsByHead(repo: string, branch: string): Promise<Pull[]> {
    const owner = repo.split('/')[0] as string;
    return this.memo(`pulls ${repo} ${branch}`, () => this.gh.list<Pull>(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`));
  }

  /** Whether `ancestor` is reachable from `head`. */
  async descends(repo: string, ancestor: string, head: string): Promise<boolean> {
    const { data } = await this.gh.rest<{ status: string }>('GET', `/repos/${repo}/compare/${ancestor}...${head}`);
    return data.status === 'ahead' || data.status === 'identical';
  }
}
