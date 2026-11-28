// The shared kit of scenarios that file Issue fixtures and wait for Nibfin's stages on them:
// one observer of the sandboxes, fixture Issues, the harness's own `pause` and the hold
// check every Issue wait shares. All writes go through public GitHub APIs.
import { randomBytes } from 'node:crypto';
import type { GitHub } from '../../src/host/github.ts';
import type { RunContext } from '../../src/types.ts';
import { AGENT_STAGES, markerOf, parseStageTitle, parseWakeTitle, selfHosted, stageRuns, time } from './analysis.ts';
import type { Issue, Job, Run, Stage } from './analysis.ts';
import { AUTO_CLEARED_CLASSES, briefRecord, pendingAddedAt, resolutionRecord } from './resolution.ts';
import { Observer } from './observer.ts';
import type { Expects, IssueRef, Snapshot } from './observer.ts';

const MIN = 60_000;

/** How long each kind of wait may take. The fixtures share the host's Runners with other scenarios' Jobs. */
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
 * How long the repair stage (Proposal R4.40–R4.42) may take before a stage wait stops
 * tolerating `pending`: to write its record after `pending` was added, and to remove
 * `pending` after a record of a class it clears automatically was last written. It is
 * below `STALL`, so on a quiet sandbox the named reason comes before the stall message.
 */
export const REPAIR_GRACE = 10 * MIN;
/** The characters of a Nibfin comment one full quote keeps; longer text is cut at its end. */
export const QUOTE_LIMIT = 1500;

export interface GoneOptions {
  /**
   * `pending` never ends the wait (the harness adds it itself). Without it, only a `pending`
   * the repair stage is clearing automatically is tolerated, within `REPAIR_GRACE`.
   */
  allowPending?: boolean;
}

export interface FixtureSpec {
  scenario: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  /** Unique per run: fixture titles, files and tags carry it. */
  readonly tag: string;
  /**
   * The Issues ("repo#n") the harness added `pause` to, recorded just before it adds it. The
   * hold check exempts the harness's own `pause`
   * (the timeline cannot tell, since the harness may act with the Owner's token). It
   * lives in memory: concurrent scenarios of one run share the kit and so the record.
   */
  private readonly ownPause = new Set<string>();

  constructor(ctx: RunContext, opts: KitOptions = {}) {
    this.ctx = ctx;
    this.gh = ctx.github;
    this.exec = ctx.sandbox.execution;
    const now = opts.now ?? (() => Date.now());
    this.tag = opts.tag ?? `r${randomBytes(3).toString('hex')}`;
    this.obs = new Observer(this.gh, [this.exec, ctx.sandbox.peer], {
      // Runs created a minute before the start still count, so a clock skew loses nothing.
      since: now() - MIN,
      now,
      sleep: opts.sleep,
      intervalMs: opts.intervalMs,
      log: ctx.log,
      signal: ctx.signal,
      stallMs: opts.stallMs ?? STALL,
      held: (s, i, e) => this.heldReason(s, i.repo, i.n, e),
    });
  }

  now(): number {
    return this.obs.now();
  }

  async owner(): Promise<{ login: string; id: number }> {
    return { login: await this.ctx.ownerLogin(), id: await this.ctx.ownerId() };
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
    if (spec.labels?.includes('pause')) this.ownPause.add(`${repo}#${data.number}`);
    this.ctx.log(`${spec.scenario}: filed ${repo}#${data.number} ${spec.title}`);
    return data;
  }

  async addLabels(repo: string, n: number, labels: string[]): Promise<void> {
    // Recorded before the write, so no snapshot shows the harness's `pause` ahead of the record.
    if (labels.includes('pause')) this.ownPause.add(`${repo}#${n}`);
    await this.gh.rest('POST', `/repos/${repo}/issues/${n}/labels`, { labels });
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

  // ---- readings over a snapshot ----

  issue(s: Snapshot, repo: string, n: number): Issue | undefined {
    return s.issues.get(repo)?.find((i) => i.number === n);
  }

  labels(s: Snapshot, repo: string, n: number): string[] {
    return this.issue(s, repo, n)?.labels.map((l) => l.name) ?? [];
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

  /** The `issues` option of a wait on the progress of these Issues of `repo`, so the hold check judges each. */
  about(repo: string, ...numbers: [number, ...number[]]): { issues: [IssueRef, ...IssueRef[]] } {
    const [first, ...rest] = numbers;
    return { issues: [{ repo, n: first }, ...rest.map((n) => ({ repo, n }))] };
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

  /**
   * A `gonePast` check for a wait on one stage of an Issue: the first reason the wait
   * can no longer succeed. The Issue is closed; it has `pending` (unless allowed) that the
   * repair stage is not clearing automatically (see `pendingReason`); or a job of the stage
   * completed and a run of another agent stage was created after it. Only the stage's jobs
   * created since a minute before the check was made count.
   */
  stageGone(
    repo: string,
    n: number,
    stage: Stage,
    opts: GoneOptions = {},
  ): (s: Snapshot) => Promise<string | undefined> {
    const since = this.now() - MIN;
    const name = repo === this.exec ? `#${n}` : `${repo}#${n}`;
    // `pause` is the shared wait's to judge (`heldReason`); this check keeps to closure, `pending` and the stage.
    const expects: Expects = {
      pause: 'stageGone judges only closure, pending and the stage',
      ...(opts.allowPending ? { pending: 'the caller allows pending' } : {}),
    };
    return async (s) => {
      const reason = await (async () => {
        const held = await this.hold(s, repo, n, expects);
        if (held !== undefined) return held;
        const later = this.stages(s, repo, n, AGENT_STAGES).filter((r) => r.stage !== stage);
        for (const j of await this.agentJobs(s, repo, n, [stage])) {
          if (j.status !== 'completed' || time(j.created_at ?? j.run.created_at) < since) continue;
          const next = later.find((r) => time(r.created_at) > time(j.completed_at));
          if (next)
            return `${name}'s ${stage} job ${j.id} completed (run ${j.run.id}, ${String(j.conclusion)}) and a ${next.stage} run ${next.id} followed`;
        }
        return undefined;
      })();
      return reason === undefined ? undefined : redact(reason, this.ctx.secretValues());
    };
  }

  /**
   * The shared hold check of every wait naming the Issue (the observer's `held`):
   * why the Issue's progress is held and the wait can no longer succeed, unless `expects`
   * names that hold (Proposal R4.12, R4.13, R1.14). The Issue is closed (with `delivered`,
   * or past `CLOSE_GRACE` without it); it has `pending` the repair stage is not clearing
   * automatically (`pendingReason`), whoever added it; or it has `pause` the harness did
   * not add. Undefined when the snapshot does not show the Issue; secrets are redacted.
   */
  async heldReason(s: Snapshot, repo: string, n: number, expects: Expects): Promise<string | undefined> {
    const reason = await this.hold(s, repo, n, expects);
    return reason === undefined ? undefined : redact(reason, this.ctx.secretValues());
  }

  private async hold(s: Snapshot, repo: string, n: number, expects: Expects): Promise<string | undefined> {
    const i = this.issue(s, repo, n);
    if (!i) return undefined;
    const name = repo === this.exec ? `#${n}` : `${repo}#${n}`;
    if (expects.closed === undefined && i.state === 'closed') {
      const delivered = i.labels.some((l) => l.name === 'delivered');
      if (delivered || !(s.at - time(i.closed_at) < CLOSE_GRACE))
        return `${name} is closed (${i.state_reason ?? 'no reason'})${delivered ? ' with delivered' : ' without delivered'}`;
    }
    if (expects.pending === undefined && i.labels.some((l) => l.name === 'pending'))
      return this.pendingReason(s, repo, n, name);
    if (expects.pause === undefined && i.labels.some((l) => l.name === 'pause') && !this.ownPause.has(`${repo}#${n}`))
      return `${name} has pause, which the scenario did not add${fullQuote(await this.lastComment(repo, n))}`;
    return undefined;
  }

  /**
   * Why a `pending` on the Issue ends a stage wait, or undefined while the repair stage may
   * still clear it (Proposal R4.42): its latest record after `pending` was last added names a
   * class it clears automatically and gives no options or next steps, until `REPAIR_GRACE`
   * after the record was last written or while a run of the Issue is queued or in progress;
   * or no record exists yet, for a fixed `REPAIR_GRACE` after `pending` was added. Any other
   * `pending` ends the wait with the record's class and why (R4.45–R4.47). A failed read
   * throws, so the observer logs it and judges the next snapshot.
   */
  private async pendingReason(s: Snapshot, repo: string, n: number, name: string): Promise<string | undefined> {
    const pendingAt = await pendingAddedAt(this.gh, repo, n);
    const rec = resolutionRecord(await this.obs.comments(repo, n), pendingAt);
    const min = (ms: number) => Math.floor(ms / MIN);
    if (!rec) {
      if (s.at - pendingAt < REPAIR_GRACE) return undefined;
      return `${name} has pending; no repair record ${min(s.at - pendingAt)} min after pending was added at ${new Date(pendingAt).toISOString()}${fullQuote(await this.lastComment(repo, n))}`;
    }
    const quote = `; repair record ${rec.url || 'no URL'}: ${briefRecord(rec.body)}`;
    if (!rec.class || !AUTO_CLEARED_CLASSES.has(rec.class))
      return `${name} has pending; repair record class ${rec.class ?? 'not recognised'}, which Nibfin does not clear automatically${quote}`;
    if (rec.options.length > 0 || rec.nextSteps)
      return `${name} has pending; repair record class ${rec.class} gives options or next steps, so pending stays${quote}`;
    const mine = this.runsOf(repo, n);
    if (s.at - rec.at < REPAIR_GRACE || s.runs.some((r) => mine(r) && r.status !== 'completed')) return undefined;
    return `${name} has pending ${min(s.at - rec.at)} min after its ${rec.class} repair record was last written at ${new Date(rec.at).toISOString()}, and no run of ${name} is queued or in progress${quote}`;
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

  /**
   * A one-line state of an Issue for failure messages: labels, state and its runs, and the last
   * Nibfin comment's code and run link.
   */
  async summary(s: Snapshot, repo: string, n: number): Promise<string> {
    const i = this.issue(s, repo, n);
    if (!i) return `${repo}#${n} not found`;
    const runs = this.stages(s, repo, n)
      .slice(-8)
      .map((r) => `${r.stage} ${r.status}${r.conclusion ? `/${r.conclusion}` : ''}`);
    const last = shortQuote(await this.lastComment(repo, n));
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

/** The kit of this run: one per context, so scenarios of one run share the observer and the record of the harness's own `pause`. */
export function kitFor(ctx: RunContext): Kit {
  let k = kits.get(ctx.github);
  if (!k) kits.set(ctx.github, (k = new Kit(ctx)));
  return k;
}
