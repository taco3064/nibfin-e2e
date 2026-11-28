// What every lifecycle scenario shares: one observer, fixture Issues, hook rules, the
// execution baseline and the shared journeys. All writes go through public GitHub APIs.
import { randomBytes } from 'node:crypto';
import type { GitHub } from '../../src/host/github.ts';
import type { Outcome, RunContext, Scenario } from '../../src/types.ts';
import {
  AGENT_STAGES,
  STAGES,
  describeJob,
  githubHosted,
  hostedOnlyProblems,
  issueKey,
  jobWindow,
  markerOf,
  parseStageTitle,
  parseWakeTitle,
  selfHosted,
  stageRuns,
  time,
  windowAt,
} from './analysis.ts';
import type { Issue, Job, Run, Stage, Window } from './analysis.ts';
import { Observer } from './observe.ts';
import type { Snapshot } from './observe.ts';

const MIN = 60_000;

/** How long each kind of wait may take. Phase 2 shares two Runners among many fixtures. */
export const DEADLINE = {
  /** A wake or route run, a label or a comment after an event. */
  event: 30 * MIN,
  /** One agent stage, including its queue time behind other Issues. */
  stage: 150 * MIN,
  /** A whole delivery from `scope` to closure. */
  delivery: 300 * MIN,
  /** How long "nothing happens" is watched before it is accepted. */
  quiet: 5 * MIN,
} as const;

/** A wait not expecting silence fails once the sandboxes showed no activity for this long (the last resort before its deadline). */
export const STALL = 20 * MIN;
/** How long an Issue may show closed without `delivered` before a wait counts it as closed: Nibfin may label and close in either order. */
const CLOSE_GRACE = 2 * MIN;
/**
 * How long after a successful stage job completed its label may still be missing before a
 * wait counts the stage as not published (a paused Issue is not published, Proposal R4.12).
 */
export const PUBLISH_GRACE = DEADLINE.quiet;
/** The characters of a Nibfin comment one full quote keeps; longer text is cut at its end. */
export const QUOTE_LIMIT = 1500;

export interface GoneOptions {
  /** Only the stage's jobs created at or after this epoch ms count (default: when the check is made, minus one minute). */
  since?: number;
  /** `pending` does not end the wait (the harness adds it itself). */
  allowPending?: boolean;
  /** Whether a completed job of the stage followed by another agent stage ends the wait (default true). */
  jobs?: boolean;
  /** The label the stage adds when it succeeds: a successful job of the stage and no such label `PUBLISH_GRACE` later end the wait (needs `jobs`). */
  publishes?: string;
}

export interface Hook {
  when: string;
  event?: 'push' | 'pull_request';
  attempt?: number;
  require?: { file: string; contains: string };
  holdTag?: string;
}

export interface FixtureSpec {
  scenario: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

/** A route or finish job with its window (`undefined` when no runner took it). */
export type WindowedJob = Job & { stage: Stage; run: Run; window: Window | undefined };
export type FinishJob = WindowedJob;

/** The finish job whose window contains `t`; with `hostedOnly`, only GitHub-hosted ones count (Proposal R5.72, R5.74). */
export function finishAt(
  jobs: FinishJob[],
  t: number,
  hostedOnly = true,
): (FinishJob & { window: Window }) | undefined {
  const ran = jobs.filter(
    (j): j is FinishJob & { window: Window } => j.window !== undefined && (!hostedOnly || githubHosted(j)),
  );
  return windowAt(
    t,
    ran.map((j) => ({ ...j.window, job: j })),
  )?.job;
}

/** R5.70, R5.72, R5.74: problems of every route or finish run among the jobs, each run judged by `hostedOnlyProblems`. */
export function hostedRunProblems(jobs: WindowedJob[], sandboxRunners: string[]): string[] {
  const runs = new Map<number, { run: Run; jobs: Job[] }>();
  for (const j of jobs) {
    const e = runs.get(j.run.id) ?? { run: j.run, jobs: [] };
    e.jobs.push(j);
    runs.set(j.run.id, e);
  }
  return [...runs.values()].flatMap((e) => hostedOnlyProblems(e.run, e.jobs, sandboxRunners));
}

/** The runs and jobs of `stage` seen, for failure messages. */
export function stageSeen(jobs: WindowedJob[], stage: 'route' | 'finish' = 'finish'): string {
  if (!jobs.length) return `no ${stage} job was seen`;
  const win = (j: WindowedJob) =>
    j.window
      ? ` window ${new Date(j.window.start).toISOString()}–${j.window.end === Infinity ? 'running' : new Date(j.window.end).toISOString()}`
      : ' no window';
  return `${stage} jobs seen: ${jobs.map((j) => `${describeJob(j.run, j)}${win(j)}`).join('; ')}`;
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A request for a few-line change with its own test, in files only this fixture touches. */
export function changeRequest(slug: string, fn: string, behaviour: string, extra = ''): string {
  return [
    `Add \`src/${slug}.js\` exporting a function \`${fn}\` that ${behaviour}, and a \`node:test\` test for it in \`test/${slug}.test.js\`.`,
    'Keep the change to these two files.',
    extra,
    '_This Issue is an automated nibfin-e2e fixture._',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Replaces every secret value in a text. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out;
}

export interface KitOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  tag?: string;
  /** The stall limit of the observer's waits (default `STALL`). */
  stallMs?: number;
}

export class Kit {
  readonly ctx: RunContext;
  readonly gh: GitHub;
  readonly obs: Observer;
  readonly exec: string;
  readonly peer: string;
  /** Unique per run: fixture titles, files and tags carry it. */
  readonly tag: string;
  readonly start: number;
  /** The kit's sleep, for waits outside the observer (`waitFor`); undefined means real time. */
  readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly memos = new Map<string, Promise<unknown>>();

  constructor(ctx: RunContext, opts: KitOptions = {}) {
    this.ctx = ctx;
    this.gh = ctx.github;
    this.exec = ctx.sandbox.execution;
    this.peer = ctx.sandbox.peer;
    const now = opts.now ?? (() => Date.now());
    // Runs created a minute before the start still count, so a clock skew loses nothing.
    this.start = now() - MIN;
    this.sleep = opts.sleep;
    this.tag = opts.tag ?? `r${randomBytes(3).toString('hex')}`;
    this.obs = new Observer(this.gh, [this.exec, this.peer], {
      since: this.start,
      now,
      sleep: opts.sleep,
      intervalMs: opts.intervalMs,
      log: ctx.log,
      signal: ctx.signal,
      stallMs: opts.stallMs ?? STALL,
    });
  }

  now(): number {
    return this.obs.now();
  }

  /** Runs `fn` once per kit; later callers share its promise. */
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memos.get(key) as Promise<T> | undefined;
    if (!p) this.memos.set(key, (p = fn()));
    return p;
  }

  async owner(): Promise<{ login: string; id: number }> {
    return { login: await this.ctx.ownerLogin(), id: await this.ctx.ownerId() };
  }

  /** The routing label of the Owner's Runners (Proposal R4.18). */
  async ownerLabel(): Promise<string> {
    return `nibfin-${await this.ctx.ownerId()}`;
  }

  slug(kind: string): string {
    return `e2e-${kind}-${this.tag}`;
  }

  async file(repo: string, spec: FixtureSpec): Promise<Issue> {
    const { data } = await this.gh.rest<Issue>('POST', `/repos/${repo}/issues`, {
      title: `[e2e ${spec.scenario}] ${spec.title} (${this.tag})`,
      body: spec.body,
      labels: spec.labels ?? [],
      assignees: spec.assignees ?? [],
    });
    this.ctx.log(`${spec.scenario}: filed ${repo}#${data.number} ${spec.title}`);
    return data;
  }

  async addLabels(repo: string, n: number, labels: string[]): Promise<void> {
    await this.gh.rest('POST', `/repos/${repo}/issues/${n}/labels`, { labels });
  }

  async removeLabel(repo: string, n: number, label: string): Promise<void> {
    await this.gh.rest('DELETE', `/repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`, undefined, [404]);
  }

  /** Adds `pause` to the given Issues that are still open; used in `finally`, so it never throws. */
  async pauseOpen(repo: string, numbers: (number | undefined)[]): Promise<void> {
    for (const n of numbers) {
      if (n === undefined) continue;
      try {
        const { data } = await this.gh.rest<Issue>('GET', `/repos/${repo}/issues/${n}`);
        if (data.state === 'open' && !data.labels.some((l) => l.name === 'pause'))
          await this.addLabels(repo, n, ['pause']);
      } catch (error) {
        this.ctx.log(`could not pause ${repo}#${n}: ${message(error)}`);
      }
    }
  }

  /** Adds native `Blocked by` edges and reads them back. */
  async blockBy(repo: string, n: number, blockers: Issue[]): Promise<void> {
    for (const b of blockers)
      await this.gh.rest('POST', `/repos/${repo}/issues/${n}/dependencies/blocked_by`, { issue_id: b.id });
    const got = (await this.gh.list<Issue>(`/repos/${repo}/issues/${n}/dependencies/blocked_by`))
      .map((i) => i.number)
      .sort();
    const want = blockers.map((b) => b.number).sort();
    if (JSON.stringify(got) !== JSON.stringify(want))
      throw new Error(`${repo}#${n} is blocked by ${got.join(', ') || 'nothing'}, expected ${want.join(', ')}`);
  }

  /** Appends rules to `E2E_CI_RULES` or `E2E_CD_RULES` of the execution sandbox (serialized read-modify-write) and reads them back. */
  hookRules(kind: 'ci' | 'cd', rules: Hook[]): Promise<void> {
    const run = async () => {
      const name = kind === 'ci' ? 'E2E_CI_RULES' : 'E2E_CD_RULES';
      const path = `/repos/${this.exec}/actions/variables`;
      const cur = await this.gh.rest<{ value: string }>('GET', `${path}/${name}`, undefined, [404]);
      const list = cur.status === 404 ? [] : (JSON.parse(cur.data.value || '[]') as Hook[]);
      const value = JSON.stringify([...list, ...rules]);
      if (cur.status === 404) await this.gh.rest('POST', path, { name, value });
      else await this.gh.rest('PATCH', `${path}/${name}`, { name, value });
      const { data } = await this.gh.rest<{ value: string }>('GET', `${path}/${name}`);
      if (data.value !== value)
        throw new Error(`${this.exec} variable ${name} reads back ${data.value}, expected ${value}`);
    };
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** A fast-forward commit on the branch adding or replacing files (Git Data API). */
  async commitFiles(repo: string, branch: string, files: Record<string, string>, msg: string): Promise<string> {
    const r = `/repos/${repo}`;
    const { data: head } = await this.gh.rest<{ object: { sha: string } }>(
      'GET',
      `${r}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
    );
    const { data: parent } = await this.gh.rest<{ tree: { sha: string } }>(
      'GET',
      `${r}/git/commits/${head.object.sha}`,
    );
    const { data: tree } = await this.gh.rest<{ sha: string }>('POST', `${r}/git/trees`, {
      base_tree: parent.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    });
    const { data: commit } = await this.gh.rest<{ sha: string }>('POST', `${r}/git/commits`, {
      message: msg,
      tree: tree.sha,
      parents: [head.object.sha],
    });
    await this.gh.rest('PATCH', `${r}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, {
      sha: commit.sha,
      force: false,
    });
    return commit.sha;
  }

  async fileOn(repo: string, ref: string, path: string): Promise<string | undefined> {
    const got = await this.gh.rest<{ content: string }>(
      'GET',
      `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      undefined,
      [404],
    );
    return got.status === 404 ? undefined : Buffer.from(got.data.content, 'base64').toString('utf8');
  }

  /** Creates a ruleset on the default branch unless one of that name exists; returns its id. */
  async ruleset(name: string, rules: unknown[]): Promise<number> {
    const r = `/repos/${this.exec}/rulesets`;
    const existing = (await this.gh.rest<{ id: number; name: string }[]>('GET', `${r}?per_page=100`)).data.find(
      (x) => x.name === name,
    );
    if (existing) return existing.id;
    const { data } = await this.gh.rest<{ id: number }>('POST', r, {
      name,
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules,
    });
    return data.id;
  }

  async deleteRuleset(name: string): Promise<void> {
    const r = `/repos/${this.exec}/rulesets`;
    for (const x of (await this.gh.rest<{ id: number; name: string }[]>('GET', `${r}?per_page=100`)).data) {
      if (x.name === name) await this.gh.rest('DELETE', `${r}/${x.id}`, undefined, [404]);
    }
  }

  /**
   * The phase-2 execution baseline, once: a deliver Skill extension (so a role Skill
   * file outside the protected directories exists), then the `e2e-ci` ruleset requiring
   * `test`, then `NIBFIN_PROVIDER=codex` for R4.17. The commit comes first because the
   * ruleset refuses direct pushes to main.
   */
  baseline(): Promise<void> {
    return this.once('baseline', async () => {
      const config =
        JSON.stringify({ skills: { deliver: { mode: 'extend', path: 'docs/agent/deliver.md' } } }, null, 2) + '\n';
      const skill = 'Keep each change as small as the Issue allows.\n';
      if (
        (await this.fileOn(this.exec, 'main', '.nibfin.json')) !== config ||
        (await this.fileOn(this.exec, 'main', 'docs/agent/deliver.md')) !== skill
      ) {
        await this.commitFiles(
          this.exec,
          'main',
          { '.nibfin.json': config, 'docs/agent/deliver.md': skill },
          'Extend the deliver Skill for the e2e baseline',
        );
      }
      await this.ruleset('e2e-ci', [
        {
          type: 'required_status_checks',
          parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'test' }] },
        },
      ]);
      const v = `/repos/${this.exec}/actions/variables`;
      const cur = await this.gh.rest<{ value: string }>('GET', `${v}/NIBFIN_PROVIDER`, undefined, [404]);
      if (cur.status === 404) await this.gh.rest('POST', v, { name: 'NIBFIN_PROVIDER', value: 'codex' });
      else if (cur.data.value !== 'codex')
        await this.gh.rest('PATCH', `${v}/NIBFIN_PROVIDER`, { name: 'NIBFIN_PROVIDER', value: 'codex' });
      const back = await this.gh.rest<{ value: string }>('GET', `${v}/NIBFIN_PROVIDER`);
      if (back.data.value !== 'codex')
        throw new Error(`${this.exec} variable NIBFIN_PROVIDER reads back ${back.data.value}`);
    });
  }

  // ---- readings over a snapshot ----

  issue(s: Snapshot, repo: string, n: number): Issue | undefined {
    return s.issues.get(repo)?.find((i) => i.number === n);
  }

  labels(s: Snapshot, repo: string, n: number): string[] {
    return this.issue(s, repo, n)?.labels.map((l) => l.name) ?? [];
  }

  delivered(s: Snapshot, repo: string, n: number): Issue | undefined {
    const i = this.issue(s, repo, n);
    return i && i.state === 'closed' && i.labels.some((l) => l.name === 'delivered') ? i : undefined;
  }

  stages(s: Snapshot, repo: string, n: number, stages?: readonly Stage[]): (Run & { stage: Stage })[] {
    return stageRuns(s.runs, this.exec, repo, n, stages);
  }

  /** Jobs of the Issue's runs of these stages, each with its stage. */
  async stageJobs(
    s: Snapshot,
    repo: string,
    n: number,
    stages: readonly Stage[] = AGENT_STAGES,
  ): Promise<(Job & { stage: Stage; run: Run })[]> {
    const out: (Job & { stage: Stage; run: Run })[] = [];
    for (const run of this.stages(s, repo, n, stages))
      for (const j of await this.obs.jobs(this.exec, run.id)) out.push({ ...j, stage: run.stage, run });
    return out;
  }

  /** Jobs of the Issue's runs of these stages, each with its window (`undefined` when no runner took it). */
  async windowedJobs(s: Snapshot, repo: string, n: number, stages: readonly Stage[]): Promise<WindowedJob[]> {
    return (await this.stageJobs(s, repo, n, stages)).map((j) => ({
      ...j,
      window: jobWindow(j, issueKey(repo, n), j.stage),
    }));
  }

  /** Jobs of the Issue's finish runs, each with its window (`undefined` when no runner took it). */
  async finishJobs(s: Snapshot, repo: string, n: number): Promise<FinishJob[]> {
    return this.windowedJobs(s, repo, n, ['finish']);
  }

  /** The agent job (self-hosted) of the Issue's runs of these stages. */
  async agentJobs(
    s: Snapshot,
    repo: string,
    n: number,
    stages: readonly Stage[] = AGENT_STAGES,
  ): Promise<(Job & { stage: Stage; run: Run })[]> {
    return (await this.stageJobs(s, repo, n, stages)).filter((j) => AGENT_STAGES.includes(j.stage) && selfHosted(j));
  }

  /** Windows of the Issue's agent jobs; `all` gives every job of every stage run, route and finish included. */
  async windows(s: Snapshot, repo: string, n: number, all = false): Promise<Window[]> {
    const jobs = all ? await this.stageJobs(s, repo, n, STAGES) : await this.agentJobs(s, repo, n);
    return jobs.flatMap((j) => jobWindow(j, issueKey(repo, n), j.stage) ?? []);
  }

  /** Whether every run in `scope` created after `after` has completed. Other Issues' runs never count. */
  quietAfter(s: Snapshot, after: number, scope: (r: Run) => boolean): boolean {
    return s.runs.every((r) => !scope(r) || time(r.created_at) < after || r.status === 'completed');
  }

  /**
   * Waits until the runs in `scope` woken after `after` have completed, seen on two
   * snapshots in a row and at least `DEADLINE.quiet` after `after`.
   */
  async settle(desc: string, after: number, scope: (r: Run) => boolean): Promise<Snapshot> {
    let calm = 0;
    return this.obs.until(
      `${desc}: the runs it woke to complete`,
      (s) => {
        calm = this.quietAfter(s, after, scope) ? calm + 1 : 0;
        return calm >= 2 && s.at - after >= DEADLINE.quiet ? s : undefined;
      },
      DEADLINE.stage,
      (s) => {
        const open = s.runs.filter((r) => scope(r) && time(r.created_at) >= after && r.status !== 'completed');
        return `still running: ${open.map((r) => `${r.display_title} (${r.status})`).join(', ') || 'nothing (waiting for the quiet period)'}`;
      },
      { quiet: true },
    );
  }

  /**
   * A `gonePast` check for a wait on one stage of an Issue: the first reason the wait
   * can no longer succeed. The Issue is closed; it has `pending` (unless allowed); or a
   * job of the stage completed and a run of another agent stage was created after it;
   * or, with `publishes`, a job of the stage succeeded and the Issue still lacks that
   * label `PUBLISH_GRACE` after the job completed.
   */
  stageGone(
    repo: string,
    n: number,
    stage: Stage,
    opts: GoneOptions = {},
  ): (s: Snapshot) => Promise<string | undefined> {
    const since = opts.since ?? this.now() - MIN;
    const name = repo === this.exec ? `#${n}` : `${repo}#${n}`;
    return async (s) => {
      const reason = await (async () => {
        const i = this.issue(s, repo, n);
        if (i?.state === 'closed') {
          const delivered = i.labels.some((l) => l.name === 'delivered');
          if (delivered || !(s.at - time(i.closed_at) < CLOSE_GRACE))
            return `${name} is closed (${i.state_reason ?? 'no reason'})${delivered ? ' with delivered' : ' without delivered'}`;
        }
        if (!opts.allowPending && i?.labels.some((l) => l.name === 'pending'))
          return `${name} has pending${fullQuote(await this.lastComment(repo, n))}`;
        if (opts.jobs === false) return undefined;
        const later = this.stages(s, repo, n, AGENT_STAGES).filter((r) => r.stage !== stage);
        for (const j of await this.agentJobs(s, repo, n, [stage])) {
          if (j.status !== 'completed' || time(j.created_at ?? j.run.created_at) < since) continue;
          const next = later.find((r) => time(r.created_at) > time(j.completed_at));
          if (next)
            return `${name}'s ${stage} job ${j.id} completed (run ${j.run.id}, ${String(j.conclusion)}) and a ${next.stage} run ${next.id} followed`;
        }
        const label = opts.publishes;
        const labels = i?.labels.map((l) => l.name) ?? [];
        if (label === undefined || labels.includes(label)) return undefined;
        for (const j of await this.agentJobs(s, repo, n, [stage])) {
          if (j.status !== 'completed' || j.conclusion !== 'success' || time(j.created_at ?? j.run.created_at) < since)
            continue;
          const after = s.at - time(j.completed_at);
          if (after >= PUBLISH_GRACE)
            return `${name}'s ${stage} job ${j.id} completed (run ${j.run.id}, success) and ${name} has no ${label} ${Math.floor(after / MIN)} min later (labels: ${labels.join(', ') || 'none'})`;
        }
        return undefined;
      })();
      return reason === undefined ? undefined : redact(reason, this.ctx.secretValues());
    };
  }

  /** `stageGone` for a wait on the Issue's closure: only closed without `delivered` and `pending` end it. */
  closeGone(repo: string, n: number): (s: Snapshot) => Promise<string | undefined> {
    return this.stageGone(repo, n, 'review', { jobs: false });
  }

  /**
   * The Issue's last Nibfin-marked comment, its text without HTML comments, whitespace collapsed
   * and secrets redacted before any cut; comments are only context, so a failed read gives undefined.
   */
  private async lastComment(repo: string, n: number): Promise<LastComment | undefined> {
    try {
      const c = (await this.obs.comments(repo, n)).filter((x) => markerOf(x.body)).at(-1);
      if (!c) return undefined;
      const text = redact(
        (c.body ?? '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
        this.ctx.secretValues(),
      );
      return { text, url: c.html_url ?? '' };
    } catch {
      return undefined;
    }
  }

  /** The runs that belong to one Issue: its stage runs in the execution repository and its wake runs. */
  runsOf(repo: string, n: number): (r: Run) => boolean {
    return (r) => {
      const st = parseStageTitle(r.display_title);
      if (st) return r.repo === this.exec && st.repo === repo && st.issue === n;
      const w = parseWakeTitle(r.display_title);
      return w !== undefined && w.repo === repo && w.issue === n;
    };
  }

  /** When a label was first added after `after`, from the Issue's timeline. */
  async labeledAt(repo: string, n: number, label: string, after = 0): Promise<number | undefined> {
    const ev = (await this.obs.timeline(repo, n)).find(
      (e) => e.event === 'labeled' && e.label?.name === label && time(e.created_at) >= after,
    );
    return ev ? time(ev.created_at) : undefined;
  }

  /**
   * A one-line state of an Issue for failure messages: labels, state and its runs, and the last
   * Nibfin comment's code and run link; with `full`, that comment's whole text (for messages
   * where the summary is the only copy of it).
   */
  async summary(s: Snapshot, repo: string, n: number, opts: { full?: boolean } = {}): Promise<string> {
    const i = this.issue(s, repo, n);
    if (!i) return `${repo}#${n} not found`;
    const runs = this.stages(s, repo, n)
      .slice(-8)
      .map((r) => `${r.stage} ${r.status}${r.conclusion ? `/${r.conclusion}` : ''}`);
    const comment = await this.lastComment(repo, n);
    const last = opts.full ? fullQuote(comment) : shortQuote(comment);
    return redact(
      `${repo}#${n} ${i.state}${i.state_reason ? ` (${i.state_reason})` : ''} [${i.labels.map((l) => l.name).join(', ')}] runs: ${runs.join(', ') || 'none'}${last}`,
      this.ctx.secretValues(),
    );
  }

  show(repo: string, ...numbers: number[]): (s: Snapshot) => Promise<string> {
    return async (s) => (await Promise.all(numbers.map((n) => this.summary(s, repo, n)))).join(' | ');
  }
}

interface LastComment {
  text: string;
  url: string;
}

/** `; last Nibfin comment: <text>`, cut at the end past `QUOTE_LIMIT` on a whole token and marked with the dropped count and the comment URL. */
function fullQuote(c: LastComment | undefined): string {
  if (!c) return '';
  if (c.text.length <= QUOTE_LIMIT) return `; last Nibfin comment: ${c.text}`;
  const space = c.text.lastIndexOf(' ', QUOTE_LIMIT);
  const kept = c.text.slice(0, space > 0 ? space : QUOTE_LIMIT);
  return `; last Nibfin comment: ${kept} … (cut, ${c.text.length - kept.length} more characters; full comment: ${c.url || 'no URL'})`;
}

/** `; last Nibfin comment: Code: <CODE>, Run: <URL>` with the parts present, else the comment URL, else nothing. */
function shortQuote(c: LastComment | undefined): string {
  if (!c) return '';
  const code = /\bCode:\s*`?([A-Z][A-Z0-9_]*)`?/.exec(c.text)?.[1];
  const run = /\bRun:\s*<?(https?:\/\/[^\s>)]+)/.exec(c.text)?.[1];
  const parts = [code && `Code: ${code}`, run && `Run: ${run}`].filter(Boolean);
  if (parts.length) return `; last Nibfin comment: ${parts.join(', ')}`;
  return c.url ? `; last Nibfin comment: ${c.url}` : '';
}

const kits = new WeakMap<object, Kit>();

/** The kit of this run: one per context, so scenarios of one run share the observer and journeys. */
export function kitFor(ctx: RunContext): Kit {
  let k = kits.get(ctx.github);
  if (!k) kits.set(ctx.github, (k = new Kit(ctx)));
  return k;
}

export interface LifecycleDef {
  id: string;
  rules: string[];
  concurrent?: boolean;
  /** Provisioning steps the scenario needs besides `nibfin` (for example `collaborator`). */
  requires?: string[];
  run(k: Kit): Promise<Outcome>;
}

/** A Linux scenario on the provisioned host; its reason never carries a secret value. */
export function lifecycle(def: LifecycleDef, makeKit: (ctx: RunContext) => Kit = kitFor): Scenario {
  return {
    id: def.id,
    rules: def.rules,
    platforms: ['linux'],
    requires: ['nibfin', ...(def.requires ?? [])],
    concurrent: def.concurrent,
    async run(ctx) {
      let out: Outcome;
      try {
        out = await def.run(makeKit(ctx));
      } catch (error) {
        out = { status: 'failed', reason: message(error) };
      }
      return { status: out.status, reason: redact(out.reason, ctx.secretValues()) };
    },
  };
}
