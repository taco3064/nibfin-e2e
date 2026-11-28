// One shared, read-only view of the sandboxes. Waiters share a snapshot that is
// refreshed at most once per interval; detail reads are cached for the same interval,
// or for good once what they read can no longer change. A wait that watches one Issue's
// stage runs also sees them, and their jobs, re-read at a shorter watch interval.
import { abortError, throwIfAborted, untilAborted } from '../../src/abort.ts';
import type { GitHub } from '../../src/host/github.ts';
import { parseLog, parseStageTitle, time } from './analysis.ts';
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
  /** How often the full snapshot of every repository is read (default 30 s). */
  intervalMs?: number;
  /** How often a watched Issue's runs and jobs are read while a wait watches it (default 10 s). */
  watchMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** The run's signal: a wait ends with its reason once it aborts (the harness budget). */
  signal?: AbortSignal;
  /**
   * A wait not marked `quiet` fails once no snapshot changed and no run was in progress
   * for this long; absent, never. It fails only on a recent snapshot judged by the
   * wait's early-exit checks (its `gonePast` and the hold check) with no reason: one whose
   * read started no earlier than one interval before the decision, or one read anew for it.
   */
  stallMs?: number;
  /**
   * The hold check of a wait that names `issues`: a reason when the Issue is held (closed,
   * or with `pending` or `pause`, Proposal R4.12, R4.13) in a way the wait does not expect.
   * A wait naming `issues` on an observer without it throws.
   */
  held?: (s: Snapshot, issue: IssueRef, expects: Expects) => Promise<string | undefined>;
}

/** An Issue a wait is about; `repo` is the full `owner/name`. */
export interface IssueRef {
  repo: string;
  n: number;
}

/** What holds an Issue so a wait on its progress can no longer succeed. */
export type Hold = 'closed' | 'pause' | 'pending';
/** The holds a wait expects, each with why. */
export type Expects = Partial<Record<Hold, string>>;

interface CommonOptions {
  /** A reason when the goal is out of reach; checked on each snapshot after `fn`, before the hold check. */
  gonePast?: (s: Snapshot) => string | undefined | Promise<string | undefined>;
  /** This wait expects silence; the stall check does not apply. */
  quiet?: boolean;
  /**
   * The Issue, or Issues, whose stage runs (in the execution repository, the first observed
   * one) this wait watches: while it runs, those runs and their jobs are read again every
   * watch interval, and `fn` and `gonePast` are also called on each such read's view.
   */
  watch?: WatchTarget | WatchTarget[];
}

export interface WatchTarget {
  issueRepo: string;
  issue: number;
}

/**
 * Every wait decides whether it is about Issues' progress. With `issues`, the observer's
 * hold check ends it once one of them is held, except for the holds `expects` names with
 * why. With `noIssue`, it says why it waits on no Issue's progress (runs to complete, a
 * harness PR's check) and gets no hold check.
 */
export type UntilOptions = CommonOptions
  & (
    | { issues: [IssueRef, ...IssueRef[]]; expects?: Expects; noIssue?: never }
    | { noIssue: string; issues?: never; expects?: never }
  );

/** What a snapshot shows of the sandboxes' activity; two equal fingerprints mean nothing changed. */
export function fingerprint(s: Pick<Snapshot, 'runs' | 'issues' | 'pulls'>): string {
  const runs = s.runs
    .map((r) => [r.repo, r.id, r.status, r.conclusion, r.run_attempt, r.updated_at])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]));
  const issues = [...s.issues].map(([repo, list]) => [
    repo,
    list
      .map((i) => [i.number, i.state, i.updated_at, (i.labels ?? []).map((l) => l.name).sort()])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  ]);
  const pulls = [...s.pulls].map(([repo, list]) => [
    repo,
    list
      .map((p) => [p.number, p.state, p.head?.sha, p.updated_at, p.merged_at])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  ]);
  return JSON.stringify([runs, issues.sort(), pulls.sort()]);
}

const DONE_JOB = (j: Job) => j.status === 'completed';

interface MemoEntry {
  gen: number;
  /** When the read began. */
  at: number;
  final: boolean;
  value: Promise<unknown>;
  /** The run the resolved value belongs to, for the watched freshness rule. */
  run?: { repo: string; id: number };
}
/** How far before the previous listing a refresh lists again, for runs GitHub creates late or a clock skew. */
const RELIST_MARGIN_MS = 10 * 60_000;

export class Observer {
  private gen = 0;
  private snap?: Snapshot;
  private pending?: Promise<Snapshot>;
  private lastAt?: number;
  private readonly cache = new Map<string, MemoEntry>();
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
  private readonly watchMs: number;
  /** Watched Issues ("repo#n") with the number of waits watching each. */
  private readonly watching = new Map<string, number>();
  private watchPending?: Promise<Snapshot>;
  /** When the latest read of the execution repository's runs (full or watched) began, and when one last finished. */
  private runsReadStartedAt = -Infinity;
  private runsReadAt?: number;

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
    this.interval = opts.intervalMs ?? 30_000;
    this.watchMs = opts.watchMs ?? 10_000;
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
   * the previous one and re-reads the runs seen earlier that had not completed (only
   * those `only` accepts, when given).
   */
  private async readRuns(repo: string, only?: (run: Run) => boolean): Promise<void> {
    const r = `/repos/${repo}`;
    const startedAt = this.now();
    const from = Math.max(this.opts.since, (this.listedAt.get(repo) ?? -Infinity) - RELIST_MARGIN_MS);
    this.listedAt.set(repo, this.now());
    const iso = new Date(from).toISOString().replace(/\.\d+Z$/, 'Z');
    const listed = new Set<number>();
    for (const run of await this.gh.list<Omit<Run, 'repo'>>(
      `${r}/actions/runs?created=${encodeURIComponent('>=' + iso)}`,
      'workflow_runs',
    )) {
      this.merge({ ...run, repo });
      listed.add(run.id);
    }
    for (const run of [...this.seen.values()]) {
      if (run.repo !== repo || run.status === 'completed' || listed.has(run.id)) continue;
      if (only && !only(run)) continue;
      const { data } = await this.gh.rest<Omit<Run, 'repo'>>('GET', `${r}/actions/runs/${run.id}`);
      this.merge({ ...data, repo });
    }
    if (repo === this.repos[0]) {
      this.runsReadStartedAt = Math.max(this.runsReadStartedAt, startedAt);
      this.runsReadAt = Math.max(this.runsReadAt ?? -Infinity, this.now());
    }
  }

  /**
   * Records a run read, unless the one already seen is newer: a watched read and a full
   * read may overlap and finish in either order. A later attempt or a later `updated_at`
   * wins, and a completed attempt is never replaced by an unfinished read of the same one.
   */
  private merge(run: Run): void {
    const key = `${run.repo} ${run.id}`;
    const old = this.seen.get(key);
    const attempt = (x: Run) => x.run_attempt ?? 1;
    if (old && attempt(old) > attempt(run)) return;
    if (old && attempt(old) === attempt(run)) {
      if (old.status === 'completed' && run.status !== 'completed') return;
      if (time(old.updated_at) > time(run.updated_at)) return;
    }
    this.seen.set(key, run);
  }

  /** Whether the run is a stage run, in the execution repository, of an Issue a wait watches. */
  private watchedRun(run: Run): boolean {
    if (run.repo !== this.repos[0] || this.watching.size === 0) return false;
    const t = parseStageTitle(run.display_title);
    return t !== undefined && this.watching.has(`${t.repo}#${t.issue}`);
  }

  /**
   * A view of the current snapshot with the execution repository's runs read again: the
   * listing of recent runs, and a re-read of the watched Issues' unfinished runs only. It
   * keeps the snapshot's generation, Issues, pulls and `startedAt`, so waits that do not
   * watch are not woken, their cached reads stay valid and the stall check counts only full
   * reads. Reads are shared, at most one per watch interval, a full read counting as one.
   */
  private watchRead(): Promise<Snapshot> {
    this.watchPending ??= (async () => {
      try {
        const due = (this.runsReadAt ?? -Infinity) + this.watchMs - this.now();
        if (due > 0) await this.sleep(due);
        await this.readRuns(this.repos[0] as string, (r) => this.watchedRun(r));
        const base = this.snap ?? (await this.next());
        return { ...base, runs: [...this.seen.values()], at: this.now() };
      } finally {
        // A failed read waits one watch interval too before the next.
        this.runsReadAt = Math.max(this.runsReadAt ?? -Infinity, this.now());
        this.watchPending = undefined;
      }
    })();
    return this.watchPending;
  }

  /**
   * For a watching wait: the next full snapshot when one newer than `seen` exists or is due
   * no later than the next watched read (one being read is past due); otherwise the next
   * watched view. A full read merely scheduled by another wait does not hold it back.
   */
  private nextWatched(seen: number): Promise<Snapshot> {
    if (!this.snap || this.snap.gen > seen) return this.next(seen);
    const fullDue = (this.lastAt ?? -Infinity) + this.interval;
    const watchDue = Math.max(this.now(), (this.runsReadAt ?? -Infinity) + this.watchMs);
    return fullDue <= watchDue ? this.next(seen) : this.watchRead();
  }

  private async read(): Promise<Snapshot> {
    const issues = new Map<string, Issue[]>();
    const pulls = new Map<string, Pull[]>();
    const startedAt = this.now();
    for (const repo of this.repos) {
      const r = `/repos/${repo}`;
      await this.readRuns(repo);
      issues.set(
        repo,
        (await this.gh.list<Issue>(`${r}/issues?state=all`)).filter((i) => i.pull_request === undefined),
      );
      pulls.set(repo, await this.gh.list<Pull>(`${r}/pulls?state=all`));
    }
    const runs = [...this.seen.values()];
    const s: Snapshot = { gen: ++this.gen, at: this.now(), startedAt, runs, issues, pulls };
    const print = fingerprint(s);
    if (print !== this.lastPrint || runs.some((r) => r.status === 'in_progress')) this.lastActivityAt = s.at;
    this.lastPrint = print;
    try {
      const { data } = await this.gh.rest<{
        resources?: { core?: { limit?: number; used?: number; remaining?: number; reset?: number } };
      }>('GET', '/rate_limit');
      const core = data.resources?.core ?? {};
      // `reset` is in UTC epoch seconds.
      const reset = typeof core.reset === 'number' ? new Date(core.reset * 1000).toISOString() : '?';
      this.opts.log?.(
        `observer: snapshot ${s.gen}, ${runs.length} runs; GitHub API: ${core.used ?? '?'} used, ${core.remaining ?? '?'} remaining of ${core.limit ?? '?'} this hour, resets at ${reset}`,
      );
    } catch {
      // The rate limit is only logged.
    }
    return s;
  }

  /**
   * Waits until `fn` returns a value other than `undefined`. On each snapshot after
   * `fn` it ends early when `opts.gonePast` gives a reason the goal is out of reach or,
   * for a wait naming `opts.issues`, when the observer's `held` check finds one of them
   * held in a way `opts.expects` does not name (the scenario's reason first, then each
   * Issue in order; only snapshots read after the wait began are judged), or
   * when the sandboxes showed no activity for `stallMs` (unless the wait is `quiet`).
   * A wait naming `issues` on an observer without `held` throws at once.
   * The stall check fails only on a recent snapshot read after the wait began and, when
   * the wait has early-exit checks, judged by them with no reason: one whose read started (its
   * `startedAt`, not `at`) no earlier than one interval before the decision. Without
   * one, as after a pass or read that blocked for long, it first reads a snapshot anew,
   * newer than every read made or in flight at the decision (a `fresh()` inside `fn`
   * included), judges it, and fails only if the calm still lasts.
   * At the deadline it fails naming what it waited for and, through `show`, the last
   * observed state. It ends with the abort reason once the run's signal aborts.
   *
   * With `opts.watch`, `fn`, `gonePast` and the hold check are also called on the views of
   * the watched reads made between full snapshots (see `watchRead`); the stall check still
   * counts full reads only. Waits without it see full snapshots only.
   *
   * A wait only reads, so a failed read (a refresh or a read inside `fn`, `gonePast`
   * or the hold check) is logged and the wait goes on to its next snapshot; the last such
   * error is named if the deadline passes. Harness writes are never repeated.
   */
  async until<T>(
    desc: string,
    fn: (s: Snapshot) => T | undefined | Promise<T | undefined>,
    timeoutMs: number,
    show: ((s: Snapshot) => string | Promise<string>) | undefined,
    opts: UntilOptions,
  ): Promise<T> {
    const watch = [opts.watch ?? []].flat().map((w) => `${w.issueRepo}#${w.issue}`);
    if (!watch.length) return this.wait(desc, fn, timeoutMs, show, { ...opts, watch: undefined });
    for (const w of watch) this.watching.set(w, (this.watching.get(w) ?? 0) + 1);
    try {
      return await this.wait(desc, fn, timeoutMs, show, opts);
    } finally {
      for (const w of watch) {
        const left = (this.watching.get(w) ?? 1) - 1;
        if (left > 0) this.watching.set(w, left);
        else this.watching.delete(w);
      }
    }
  }

  private async wait<T>(
    desc: string,
    fn: (s: Snapshot) => T | undefined | Promise<T | undefined>,
    timeoutMs: number,
    show: ((s: Snapshot) => string | Promise<string>) | undefined,
    opts: UntilOptions,
  ): Promise<T> {
    const signal = this.opts.signal;
    const held = this.opts.held;
    const issues = opts.issues;
    if (issues && !held) throw new Error(`waiting for ${desc}: no hold check installed for the Issues it names`);
    const expects = opts.expects ?? {};
    // The scenario's own reason first (it knows more), then the hold check of each Issue in order.
    const gone =
      opts.gonePast || issues
        ? async (s: Snapshot): Promise<string | undefined> => {
          const reason = await opts.gonePast?.(s);
          if (reason !== undefined || !issues || !held) return reason;
          for (const i of issues) {
            const r = await held(s, i, expects);
            if (r !== undefined) return r;
          }
          return undefined;
        }
        : undefined;
    const start = this.now();
    // Snapshots read (or being read) before the wait began may predate the caller's own
    // last write, such as removing `pending`; only later ones can show the goal out of reach.
    const staleUpTo = this.gen + (this.pending ? 1 : 0);
    const end = start + timeoutMs;
    let seen = -1;
    let lastError: string | undefined;
    let last: Snapshot | undefined;
    // The `startedAt` of the latest snapshot after `staleUpTo` that the early-exit checks (when any) judged with no reason.
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
    const stalled = (): Promise<never> =>
      fail(`no sandbox activity for ${Math.round((this.now() - calmSince()) / 60_000)} min while waiting for ${desc}`);
    // Whether the early-exit checks (when any) judged the snapshot with no reason; a reason ends the wait, a failed read is logged.
    const judge = async (s: Snapshot): Promise<boolean> => {
      if (!gone) return true;
      let reason: string | undefined;
      try {
        reason = await gone(s);
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
        const s = await (opts.watch ? this.nextWatched(seen) : this.next(seen));
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

  /**
   * Caches `fn` for this snapshot generation, or for good once `final` says the value can
   * no longer change. When `runOf` names the run a value belongs to and that run is a
   * watched Issue's, a value that is not final is served only while it is younger than the
   * watch interval and was read after the latest read of the runs began.
   */
  private memo<T>(
    key: string,
    fn: () => Promise<T>,
    final: (v: T) => boolean = () => false,
    runOf?: (v: T) => { repo: string; id: number },
  ): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && (hit.final || (hit.gen === this.gen && this.servable(hit)))) return hit.value as Promise<T>;
    const entry: MemoEntry = { gen: this.gen, at: this.now(), final: false, value: fn() as Promise<unknown> };
    this.cache.set(key, entry);
    entry.value.then(
      (v) => {
        entry.final = final(v as T);
        if (runOf) entry.run = runOf(v as T);
      },
      () => {
        if (this.cache.get(key) === entry) this.cache.delete(key);
      },
    );
    return entry.value as Promise<T>;
  }

  /** Whether a cached value of this generation may still be served (see `memo`); a read still in flight always may. */
  private servable(e: MemoEntry): boolean {
    if (!e.run) return true;
    const run = this.seen.get(`${e.run.repo} ${e.run.id}`);
    if (!run || !this.watchedRun(run)) return true;
    return this.now() - e.at < this.watchMs && e.at >= this.runsReadStartedAt;
  }

  /**
   * Every job of every attempt of a run. The list is cached per attempt of the run last
   * seen, so a re-run's new jobs are read even after every job of an earlier attempt completed.
   */
  jobs(repo: string, runId: number): Promise<Job[]> {
    const attempt = this.seen.get(`${repo} ${runId}`)?.run_attempt ?? 1;
    return this.memo(
      `jobs ${repo} ${runId} ${attempt}`,
      () => this.gh.list<Job>(`/repos/${repo}/actions/runs/${runId}/jobs?filter=all`, 'jobs'),
      (js) => js.length > 0 && js.every(DONE_JOB),
      () => ({ repo, id: runId }),
    );
  }

  job(repo: string, jobId: number): Promise<Job> {
    return this.memo(
      `job ${repo} ${jobId}`,
      async () => (await this.gh.rest<Job>('GET', `/repos/${repo}/actions/jobs/${jobId}`)).data,
      DONE_JOB,
      (j) => ({ repo, id: j.run_id }),
    );
  }

  /** A completed job's log, line by line. */
  log(repo: string, jobId: number): Promise<LogLine[]> {
    return this.memo(
      `log ${repo} ${jobId}`,
      async () => parseLog((await this.gh.download(`/repos/${repo}/actions/jobs/${jobId}/logs`)).text),
      () => true,
    );
  }

  comments(repo: string, n: number): Promise<Comment[]> {
    return this.memo(`comments ${repo} ${n}`, () => this.gh.list<Comment>(`/repos/${repo}/issues/${n}/comments`));
  }

  /**
   * Repository activity of the last day (push, force_push, branch_creation,
   * branch_deletion…), optionally for one ref or type. It pages by `Link` cursors.
   */
  activity(repo: string, filter: { ref?: string; type?: string } = {}): Promise<Activity[]> {
    const q = [
      'time_period=day',
      filter.ref && `ref=${encodeURIComponent(filter.ref)}`,
      filter.type && `activity_type=${filter.type}`,
    ]
      .filter(Boolean)
      .join('&');
    return this.memo(`activity ${repo} ${q}`, () => this.gh.listByLink<Activity>(`/repos/${repo}/activity?${q}`));
  }

  blockedBy(repo: string, n: number): Promise<Issue[]> {
    return this.memo(`blocked_by ${repo} ${n}`, () =>
      this.gh.list<Issue>(`/repos/${repo}/issues/${n}/dependencies/blocked_by`),
    );
  }

  checkRuns(
    repo: string,
    sha: string,
  ): Promise<{ name: string; status: string; conclusion: string | null; completed_at: string | null }[]> {
    return this.memo(`checks ${repo} ${sha}`, () =>
      this.gh.list(`/repos/${repo}/commits/${sha}/check-runs`, 'check_runs'),
    );
  }

  timeline(
    repo: string,
    n: number,
  ): Promise<{ event: string; created_at: string; label?: { name: string }; actor?: { login: string } | null }[]> {
    return this.memo(`timeline ${repo} ${n}`, () => this.gh.list(`/repos/${repo}/issues/${n}/timeline`));
  }

  runners(repo: string): Promise<Runner[]> {
    return this.memo(`runners ${repo}`, () => this.gh.list<Runner>(`/repos/${repo}/actions/runners`, 'runners'));
  }

  /** Every PR, open or closed, whose head is the branch. */
  pullsByHead(repo: string, branch: string): Promise<Pull[]> {
    const owner = repo.split('/')[0] as string;
    return this.memo(`pulls ${repo} ${branch}`, () =>
      this.gh.list<Pull>(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`),
    );
  }

  /** Whether `ancestor` is reachable from `head`. */
  async descends(repo: string, ancestor: string, head: string): Promise<boolean> {
    const { data } = await this.gh.rest<{ status: string }>('GET', `/repos/${repo}/compare/${ancestor}...${head}`);
    return data.status === 'ahead' || data.status === 'identical';
  }
}
