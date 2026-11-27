// One shared, read-only view of the sandboxes. Waiters share a snapshot that is
// refreshed at most once per interval; detail reads are cached for the same interval,
// or for good once what they read can no longer change.
import { abortError, throwIfAborted, untilAborted } from '../../src/abort.ts';
import type { GitHub } from '../../src/host/github.ts';
import { parseLog } from './analysis.ts';
import type { Activity, Comment, Issue, Job, LogLine, Pull, Run, Runner } from './analysis.ts';

export interface Snapshot {
  gen: number;
  /** When the read finished. */
  at: number;
  /**
   * When the read's first list call began: every list in the snapshot was read at or
   * after it, so a read that blocked on any request (a peer one included) cannot make
   * old data look recent. The stall check measures recency from it, not from `at`.
   */
  startedAt: number;
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
  /** The run's signal: a wait ends with its reason once it aborts (the harness budget). */
  signal?: AbortSignal;
  /**
   * A wait not marked `quiet` fails once no snapshot changed and no run was in progress
   * for this long; absent, never. It fails only on a recent snapshot judged by the
   * wait's `gonePast`, when given: one whose read started no earlier than one interval
   * before the decision, or one read anew for it.
   */
  stallMs?: number;
}

export interface UntilOptions {
  /** A reason when the goal is out of reach; checked on each snapshot after `fn`. */
  gonePast?: (s: Snapshot) => string | undefined | Promise<string | undefined>;
  /** This wait expects silence; the stall check does not apply. */
  quiet?: boolean;
}

/** What a snapshot shows of the sandboxes' activity; two equal fingerprints mean nothing changed. */
export function fingerprint(s: Pick<Snapshot, 'runs' | 'issues' | 'pulls'>): string {
  const runs = s.runs.map((r) => [r.repo, r.id, r.status, r.conclusion, r.run_attempt, r.updated_at]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]));
  const issues = [...s.issues].map(([repo, list]) => [repo, list.map((i) => [i.number, i.state, i.updated_at, (i.labels ?? []).map((l) => l.name).sort()]).sort((a, b) => Number(a[0]) - Number(b[0]))]);
  const pulls = [...s.pulls].map(([repo, list]) => [repo, list.map((p) => [p.number, p.state, p.head?.sha, p.updated_at, p.merged_at]).sort((a, b) => Number(a[0]) - Number(b[0]))]);
  return JSON.stringify([runs, issues.sort(), pulls.sort()]);
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
  private lastPrint?: string;
  /** When the latest snapshot that showed activity was taken: a change from the one before, or a run in progress. */
  private lastActivityAt?: number;
  /** When a refresh last failed: a failed read shows nothing, so the stall check counts calm only from after it. */
  private lastFailedAt?: number;
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
    const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.sleep = (ms) => untilAborted(sleep(ms), opts.signal);
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
      } catch (error) {
        this.lastFailedAt = this.now();
        throw error;
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
    const startedAt = this.now();
    for (const repo of this.repos) {
      const r = `/repos/${repo}`;
      await this.readRuns(repo);
      issues.set(repo, (await this.gh.list<Issue>(`${r}/issues?state=all`)).filter((i) => i.pull_request === undefined));
      pulls.set(repo, await this.gh.list<Pull>(`${r}/pulls?state=all`));
    }
    const runs = [...this.seen.values()];
    const s: Snapshot = { gen: ++this.gen, at: this.now(), startedAt, runs, issues, pulls };
    const print = fingerprint(s);
    if (print !== this.lastPrint || runs.some((r) => r.status === 'in_progress')) this.lastActivityAt = s.at;
    this.lastPrint = print;
    try {
      const { data } = await this.gh.rest<{ resources?: { core?: { remaining?: number } } }>('GET', '/rate_limit');
      this.opts.log?.(`observer: snapshot ${s.gen}, ${runs.length} runs, ${data.resources?.core?.remaining ?? '?'} requests left this hour`);
    } catch {
      // The rate limit is only logged.
    }
    return s;
  }

  /**
   * Waits until `fn` returns a value other than `undefined`. On each snapshot after
   * `fn` it ends early when `opts.gonePast` gives a reason the goal is out of reach (only
   * snapshots read after the wait began are judged), or
   * when the sandboxes showed no activity for `stallMs` (unless the wait is `quiet`).
   * The stall check fails only on a recent snapshot read after the wait began and, when
   * `gonePast` is given, judged by it with no reason: one whose read started (its
   * `startedAt`, not `at`) no earlier than one interval before the decision. Without
   * one, as after a pass or read that blocked for long, it first reads a snapshot anew,
   * newer than every read made or in flight at the decision (a `fresh()` inside `fn`
   * included), judges it, and fails only if the calm still lasts.
   * At the deadline it fails naming what it waited for and, through `show`, the last
   * observed state. It ends with the abort reason once the run's signal aborts.
   *
   * A wait only reads, so a failed read (a refresh or a read inside `fn` or
   * `gonePast`) is logged and the wait goes on to its next snapshot; the last such
   * error is named if the deadline passes. Harness writes are never repeated.
   */
  async until<T>(
    desc: string,
    fn: (s: Snapshot) => T | undefined | Promise<T | undefined>,
    timeoutMs: number,
    show?: (s: Snapshot) => string | Promise<string>,
    opts: UntilOptions = {},
  ): Promise<T> {
    const signal = this.opts.signal;
    const start = this.now();
    // Snapshots read (or being read) before the wait began may predate the caller's own
    // last write, such as removing `pending`; only later ones can show the goal out of reach.
    const staleUpTo = this.gen + (this.pending ? 1 : 0);
    const end = start + timeoutMs;
    let seen = -1;
    let lastError: string | undefined;
    let last: Snapshot | undefined;
    // The `startedAt` of the latest snapshot after `staleUpTo` that `gonePast` (when given) judged with no reason.
    let checkedAt = -Infinity;
    const fail = async (message: string): Promise<never> => {
      let state = '';
      if (show && last) state = await Promise.resolve(show(last)).catch(() => '');
      const err = lastError ? `; last read error: ${lastError}` : '';
      throw new Error(`${message}${state ? `; observed: ${state}` : ''}${err}`);
    };
    const readError = (error: unknown) => {
      if (signal?.aborted) throw abortError(signal);
      lastError = error instanceof Error ? error.message : String(error);
      // The next call to next() waits one interval before reading again.
      this.opts.log?.(`observer: a read while waiting for ${desc} failed: ${lastError}`);
    };
    const calmSince = () => Math.max(this.lastActivityAt ?? start, start, this.lastFailedAt ?? start);
    const stalled = (): Promise<never> => fail(`no sandbox activity for ${Math.round((this.now() - calmSince()) / 60_000)} min while waiting for ${desc}`);
    // Whether `gonePast` (when given) judged the snapshot with no reason; a reason ends the wait, a failed read is logged.
    const judge = async (s: Snapshot): Promise<boolean> => {
      if (!opts.gonePast) return true;
      let reason: string | undefined;
      try {
        reason = await opts.gonePast(s);
      } catch (error) {
        readError(error);
        return false;
      }
      if (reason !== undefined) await fail(`gave up waiting for ${desc}: ${reason}`);
      return true;
    };
    for (;;) {
      throwIfAborted(signal);
      let fresh: Snapshot | undefined;
      try {
        const s = await this.next(seen);
        seen = s.gen;
        last = fresh = s;
        const v = await fn(s);
        if (v !== undefined) return v;
      } catch (error) {
        readError(error);
      }
      if (fresh && fresh.gen > staleUpTo && (await judge(fresh))) checkedAt = Math.max(checkedAt, fresh.startedAt);
      const stall = this.opts.stallMs;
      if (stall !== undefined && !opts.quiet && this.now() - calmSince() >= stall) {
        if (checkedAt >= this.now() - this.interval) await stalled();
        // No recent judged snapshot: read one that starts after this decision, judge it, and fail only if the calm still lasts.
        const decidedUpTo = this.gen + (this.pending ? 1 : 0);
        let s: Snapshot | undefined;
        try {
          do s = await this.next(decidedUpTo);
          while (s.gen <= decidedUpTo);
        } catch (error) {
          readError(error);
          s = undefined;
        }
        if (s) {
          seen = s.gen;
          last = s;
          if (await judge(s)) {
            if (this.now() - calmSince() >= stall) await stalled();
            checkedAt = Math.max(checkedAt, s.startedAt);
          }
        }
      }
      if (this.now() >= end) await fail(`timed out after ${Math.round(timeoutMs / 60_000)} min waiting for ${desc}`);
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
    return this.memo(`log ${repo} ${jobId}`, async () => parseLog((await this.gh.download(`/repos/${repo}/actions/jobs/${jobId}/logs`)).text), () => true);
  }

  comments(repo: string, n: number): Promise<Comment[]> {
    return this.memo(`comments ${repo} ${n}`, () => this.gh.list<Comment>(`/repos/${repo}/issues/${n}/comments`));
  }

  /**
   * Repository activity of the last day (push, force_push, branch_creation,
   * branch_deletion…), optionally for one ref or type. It pages by `Link` cursors.
   */
  activity(repo: string, filter: { ref?: string; type?: string } = {}): Promise<Activity[]> {
    const q = ['time_period=day', filter.ref && `ref=${encodeURIComponent(filter.ref)}`, filter.type && `activity_type=${filter.type}`].filter(Boolean).join('&');
    return this.memo(`activity ${repo} ${q}`, () => this.gh.listByLink<Activity>(`/repos/${repo}/activity?${q}`));
  }

  blockedBy(repo: string, n: number): Promise<Issue[]> {
    return this.memo(`blocked_by ${repo} ${n}`, () => this.gh.list<Issue>(`/repos/${repo}/issues/${n}/dependencies/blocked_by`));
  }

  checkRuns(repo: string, sha: string): Promise<{ name: string; status: string; conclusion: string | null; completed_at: string | null }[]> {
    return this.memo(`checks ${repo} ${sha}`, () => this.gh.list(`/repos/${repo}/commits/${sha}/check-runs`, 'check_runs'));
  }

  timeline(repo: string, n: number): Promise<{ event: string; created_at: string; label?: { name: string }; actor?: { login: string } | null }[]> {
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
