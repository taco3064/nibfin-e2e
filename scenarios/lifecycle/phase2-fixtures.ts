// Phase 2 scenarios with their own fixtures: routing, the peer, protected paths and fix loops.
import { planHasNoRulesets } from '../../src/host/sandbox.ts';
import type { Scenario } from '../../src/types.ts';
import {
  AGENT_STAGES,
  Checks,
  fixPushProblems,
  isIssueBranch,
  markerOf,
  parseWakeTitle,
  pushWakeSha,
  ranOnRunner,
  reasonOf,
  selfHosted,
  time,
} from './analysis.ts';
import type { Issue, Job, Pull, Run, Stage } from './analysis.ts';
import { AFTER_DELIVERED, DEADLINE, changeRequest, lifecycle, redact } from './kit.ts';
import type { Kit } from './kit.ts';
import { PENDING_MARKER } from './marks.ts';
import type { Snapshot } from './observe.ts';
import { closingProblems } from './phase1.ts';

/** Timeline and job timestamps have second precision; events this close count in the product's favor. */
export const PAUSE_TOLERANCE_MS = 5_000;
/** One `labeled`/`unlabeled` event of `pause` on the Issue's timeline. */
export interface PauseEvent {
  event: 'labeled' | 'unlabeled';
  actor: string;
  at: number;
}
/** The scenario's own removal of `pause`: whether it was on just before, and the DELETE call's window. */
export interface OwnRemoval {
  wasOn: boolean;
  before: number;
  after: number;
}

/**
 * Why M2's deliver job should not have started when it did (R4.12/R4.26), or undefined:
 * it started while `pause` was on, or after a removal of `pause` that was not the scenario's
 * own. The own removal is told by time and state, not by login: the Owner's token and the
 * sandbox token may be the same account.
 */
export function pausedDeliverProblem(
  start: number,
  events: PauseEvent[],
  own: OwnRemoval,
  tol = PAUSE_TOLERANCE_MS,
): string | undefined {
  const ev = [...events].sort((a, b) => a.at - b.at);
  const iso = (t: number) => (Number.isNaN(t) ? 'an unknown time' : new Date(t).toISOString());
  const ownEvent = own.wasOn
    ? ev.find((e) => e.event === 'unlabeled' && e.at >= own.before - tol && e.at <= own.after + tol)
    : undefined;
  const listed = ev.length ? ev.map((e) => `${e.event} by ${e.actor} at ${iso(e.at)}`).join('; ') : 'none';
  const tail = `; pause events: ${listed}; timestamps compared with a ${tol / 1000} s tolerance`;
  const last = ev.filter((e) => e.at <= start - tol).at(-1);
  const removedNearStart = ev.some((e) => e.event === 'unlabeled' && e.at > start - tol && e.at <= start + tol);
  if (last?.event === 'labeled' && !removedNearStart)
    return `M2's deliver job started at ${iso(start)} while pause was on${tail}`;
  // The last removal before the start that actually took pause off.
  let on = false;
  let lastOff: PauseEvent | undefined;
  for (const e of ev.filter((x) => x.at <= start + tol)) {
    if (e.event === 'labeled') on = true;
    else if (on) {
      on = false;
      lastOff = e;
    }
  }
  if (!lastOff || lastOff === ownEvent) return undefined;
  const saw = own.wasOn
    ? 'the scenario saw pause on just before its own removal'
    : 'the scenario saw pause already off just before its own removal';
  return `M2's deliver job started at ${iso(start)} after pause was removed by ${lastOff.actor} at ${iso(lastOff.at)}, not by the scenario (${saw})${tail}`;
}

/**
 * What `shapeLive` saw of M2's Shape: a shape run, or its self-hosted shape job, queued
 * or in progress (`live`), or a shape job that had already completed before any read saw
 * its run or job live (`missed`), with M2's first deliver run on that snapshot, if any.
 */
export type ShapeSeen =
  | { kind: 'live'; run: Run & { stage: Stage }; job?: Job; at: number }
  | { kind: 'missed'; run: Run; job: Job; why: string; deliver?: Run & { stage: Stage } };

/**
 * Waits for M2's shape run, or its self-hosted shape job, to be seen in any status but
 * `completed` (Proposal R4.24 covers queued and running runs). The wait watches M2, so
 * the observer reads M2's runs and their jobs again every watch interval and a short job
 * is still seen (Issue #596). A shape job
 * that completed before any read saw it is returned as `missed`, not thrown; M2 closed,
 * M2 with `pending`, the stall limit and the deadline still end the wait.
 */
export async function shapeLive(
  k: Kit,
  n: number,
  o: { deadlineMs: number; show?: (s: Snapshot) => Promise<string> },
): Promise<ShapeSeen> {
  const iso = (t: number) => new Date(t).toISOString();
  /** Runs that completed without running an agent job (cancelled or skipped). */
  const finished = new Set<number>();
  /** The wait's previous look at M2's shape runs: when, and what it saw. */
  let last: { at: number; saw: string } | undefined;
  const fn = async (s: Snapshot): Promise<ShapeSeen | undefined> => {
    const at = k.now();
    const runs = k.stages(s, k.exec, n, ['shape']).filter((r) => !finished.has(r.id));
    if (!runs.length) {
      last = { at, saw: 'no unfinished shape run on its snapshot' };
      return undefined;
    }
    let missed: Extract<ShapeSeen, { kind: 'missed' }> | undefined;
    const saw: string[] = [];
    for (const run of runs) {
      // The observer lists every attempt's jobs; only the run's current attempt counts.
      const attempt = run.run_attempt ?? 1;
      const jobs = (await k.obs.jobs(k.exec, run.id)).filter(
        (j) => j.run_attempt === undefined || j.run_attempt === attempt,
      );
      const own = jobs.filter(selfHosted);
      const job = own.find((j) => j.status !== 'completed');
      if (job) return { kind: 'live', run, job, at };
      if (run.status !== 'completed') return { kind: 'live', run, at };
      const done = own.find((j) => j.conclusion !== 'cancelled' && j.conclusion !== 'skipped');
      saw.push(`run ${run.id} completed (${String(run.conclusion)})`);
      if (!done) {
        finished.add(run.id);
        continue;
      }
      const before = last ? `its previous look was at ${iso(last.at)} (${last.saw})` : 'it had not looked before';
      const why = `shape job ${done.id} (run ${run.id}) completed (${String(done.conclusion)}): started ${String(done.started_at)}, completed ${String(done.completed_at)}; the wait first read it at ${iso(at)}, already completed, and ${before}`;
      missed ??= {
        kind: 'missed',
        run,
        job: done,
        why: redact(why, k.ctx.secretValues()),
        deliver: k.stages(s, k.exec, n, ['deliver'])[0],
      };
    }
    if (missed) return missed;
    last = { at, saw: saw.join(', ') };
    return undefined;
  };
  return k.obs.until("M2's shape run or job to be queued or running", fn, o.deadlineMs, o.show, {
    ...k.about(k.exec, n),
    gonePast: k.stageGone(k.exec, n, 'shape', { jobs: false }),
    watch: k.watch(k.exec, n),
  });
}

/** The R4.24 not-exercised reason for a Shape that completed before the scenario saw it live. */
export function shapeMissedNote(m: Extract<ShapeSeen, { kind: 'missed' }>): string {
  return `M2's shape job ${m.job.id} (run ${m.run.id}) ran from ${String(m.job.started_at)} to ${String(m.job.completed_at)} before the scenario saw its run or job queued or in progress: ${m.why}`;
}

/**
 * The checks when M2's Deliver had already run before the scenario could reassign it:
 * R4.20, R4.24 and R4.26 are not exercised, naming the jobs; R4.18 is judged on the
 * deliver job's labels.
 */
export function deliverRanChecks(
  c: Checks,
  m: Extract<ShapeSeen, { kind: 'missed' }>,
  deliver: Job & { run: Run },
  label: string,
): void {
  const jobs = `M2's Deliver had already run before the scenario could reassign it: shape job ${m.job.id} (run ${m.run.id}) ran from ${String(m.job.started_at)} to ${String(m.job.completed_at)}; deliver job ${deliver.id} (run ${deliver.run.id}) started ${String(deliver.started_at)}; ${m.why}`;
  c.notExercised('R4.20', `${jobs}; so no dispatch used the reassigned list`);
  c.notExercised('R4.24', `${jobs}; so no shape run was queued or running at a reassignment`);
  c.notExercised('R4.26', `${jobs}; so M2 was never assigned to a member other than the Owner`);
  c.check(
    'R4.18',
    deliver.labels.includes(label),
    `routing used ${deliver.labels.join(', ')}, not the Assignee's label ${label}`,
  );
}

/**
 * Why M2's deliver run could not have used the reassigned list (its run was created
 * before the reassignment), so R4.20 is not exercised; undefined otherwise.
 */
export function dispatchedBefore(deliver: Job & { run: Run }, reassignedAt: number): string | undefined {
  if (!(time(deliver.run.created_at) < reassignedAt)) return undefined;
  return `M2's deliver job ${deliver.id} (run ${deliver.run.id}, created ${deliver.run.created_at}, job started ${String(deliver.started_at)}) was dispatched before the reassignment at ${new Date(reassignedAt).toISOString()}, so it could not use the new list`;
}

/** Why M2's waits between Nibfin's `pause` for the collaborator and the scenario's removal of it do not end on it (Proposal R4.26). */
const ROUTING_PAUSE = 'Nibfin adds pause for the collaborator assigned first, and the scenario removes it after shaped';

export const assigneeRouting: Scenario = lifecycle({
  id: 'assignee-routing',
  concurrent: true,
  rules: ['R4.18', 'R4.20', 'R4.22', 'R4.24', 'R4.26'],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    const filed: number[] = [];
    try {
      await k.baseline();
      const owner = await k.owner();
      const label = await k.ownerLabel();
      const collaborators = await k.gh.list<{ login: string }>(`/repos/${exec}/collaborators`);
      const other = collaborators.find((x) => x.login.toLowerCase() !== owner.login.toLowerCase());
      if (!other)
        return {
          status: 'failed',
          reason: `R4.20: ${exec} has no collaborator besides ${owner.login}; the second account (#300) must be a collaborator`,
        };

      // M1: only a member without Runners: a plain assignment, no action and no comment (R4.22).
      const m1 = await k.file(exec, {
        scenario: 'assignee-routing',
        title: 'Add triple',
        body: changeRequest(k.slug('m1'), 'triple', 'returns its argument times three'),
        labels: ['scope'],
        assignees: [other.login],
      });
      filed.push(m1.number);
      const m1At = k.now();
      await k.obs.until(
        "M1's wake and route runs to complete",
        (s) => (k.stages(s, exec, m1.number, ['route']).some((r) => r.status === 'completed') ? true : undefined),
        DEADLINE.event,
        k.show(exec, m1.number),
        // R4.22 judges a pause on M1 once its runs settled, so a pause does not end this wait.
        { ...k.about(exec, m1.number), expects: { pause: 'R4.22 checks for pause on M1 after its runs settle' } },
      );
      const s1 = await k.settle('M1 routed', m1At, k.runsOf(exec, m1.number));
      c.check(
        'R4.22',
        k.stages(s1, exec, m1.number, AGENT_STAGES).length === 0,
        'M1, assigned only to a member without Runners, got an agent stage',
      );
      c.check('R4.22', (await k.obs.comments(exec, m1.number)).length === 0, 'Nibfin commented on M1');
      c.check('R4.22', !k.labels(s1, exec, m1.number).includes('pause'), 'M1 got pause');

      // M2: reassigned to [collaborator, Owner] while its Shape is queued or running (R4.24).
      const m2 = await k.file(exec, {
        scenario: 'assignee-routing',
        title: 'Add square',
        body: changeRequest(k.slug('m2'), 'square', 'returns its argument squared'),
        labels: ['scope'],
        assignees: [owner.login],
      });
      filed.push(m2.number);
      const n = m2.number;
      const show = k.show(exec, n);
      const seen = await shapeLive(k, n, { deadlineMs: DEADLINE.stage, show });
      // Whenever a Runner ran it: before or after the removal, running or completed.
      const deliverJob = () =>
        k.obs.until(
          "M2's deliver job to start",
          async (s) =>
            (await k.agentJobs(s, exec, n, ['deliver']))
              .filter(ranOnRunner)
              .sort((a, b) => time(a.started_at) - time(b.started_at))[0],
          DEADLINE.stage,
          show,
          { ...k.about(exec, n), gonePast: k.stageGone(exec, n, 'deliver', { jobs: false }) },
        );
      if (seen.kind === 'missed' && seen.deliver) {
        k.ctx.log(
          `assignee-routing: ${shapeMissedNote(seen)}; deliver run ${seen.deliver.id} already exists, so #${n} is not reassigned`,
        );
        deliverRanChecks(c, seen, await deliverJob(), label);
        await k.addLabels(exec, n, ['pause']);
        return c.outcome(`M1 (only ${other.login}) was left alone; M2 was delivered on ${label}`);
      }
      await k.gh.rest('PATCH', `/repos/${exec}/issues/${n}`, { assignees: [other.login, owner.login] });
      const reassignedAt = k.now();
      const { data: back } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`);
      const order = back.assignees.map((a) => a.login);
      k.ctx.log(`assignee-routing: GitHub returns the Assignees of #${n} as ${order.join(', ')}`);
      await k.obs.until(
        'M2 to get pause and a comment naming the collaborator',
        async (s) => {
          if (!k.labels(s, exec, n).includes('pause')) return undefined;
          return (await k.obs.comments(exec, n)).find(
            (x) => markerOf(x.body) && x.body?.includes(other.login) && time(x.created_at) >= reassignedAt - 60_000,
          )
            ? s
            : undefined;
        },
        DEADLINE.stage,
        show,
        { ...k.about(exec, n), expects: { pause: ROUTING_PAUSE } },
      );
      if (seen.kind === 'missed') c.notExercised('R4.24', shapeMissedNote(seen));
      else {
        const live = seen;
        const shape = await k.obs.until(
          'the running shape job to complete',
          async (s): Promise<Job | { run: Run } | undefined> => {
            if (live.job) {
              const j = await k.obs.job(exec, live.job.id);
              return j.status === 'completed' ? j : undefined;
            }
            const j = (await k.obs.jobs(exec, live.run.id)).find((x) => selfHosted(x) && x.status === 'completed');
            if (j) return j;
            const r = k.stages(s, exec, n, ['shape']).find((x) => x.id === live.run.id);
            return r?.status === 'completed' ? { run: r } : undefined;
          },
          DEADLINE.stage,
          show,
          { ...k.about(exec, n), expects: { pause: ROUTING_PAUSE } },
        );
        if ('run' in shape) {
          const statuses =
            (await k.obs.jobs(exec, shape.run.id))
              .map((j) => `${j.id} ${j.name} ${j.status}/${String(j.conclusion)}`)
              .join(', ') || 'none';
          c.fail(
            'R4.24',
            `shape run ${shape.run.id}, queued or running at the reassignment, concluded ${String(shape.run.conclusion)} without a completed self-hosted job (jobs: ${statuses})`,
          );
        } else if (time(shape.completed_at) <= reassignedAt)
          c.notExercised('R4.24', `shape job ${shape.id} completed before the reassignment`);
        else
          c.check(
            'R4.24',
            shape.conclusion === 'success',
            `the shape job running at the reassignment concluded ${String(shape.conclusion)}`,
          );
      }
      await k.obs.until(
        '`shaped`',
        (s) => (k.labels(s, exec, n).includes('shaped') ? true : undefined),
        DEADLINE.event,
        show,
        { ...k.about(exec, n), expects: { pause: ROUTING_PAUSE } },
      );
      // removeLabel accepts a 404, so read whether pause was on just before the removal.
      const { data: beforeRemoval } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`);
      const wasOn = beforeRemoval.labels.some((l) => l.name === 'pause');
      const removeStart = k.now();
      await k.removeLabel(exec, n, 'pause');
      const removeEnd = k.now();
      k.ctx.log(
        `assignee-routing: pause was ${wasOn ? 'on' : 'already off'} on #${n} just before the scenario removed it`,
      );
      const deliver = await deliverJob();
      const timeline = (await k.obs.timeline(exec, n)) as {
        event: string;
        created_at: string;
        label?: { name: string };
        actor?: { login: string } | null;
      }[];
      const pauseEvents = timeline.flatMap((e): PauseEvent[] =>
        (e.event === 'labeled' || e.event === 'unlabeled') && e.label?.name === 'pause'
          ? [{ event: e.event, actor: e.actor?.login ?? 'unknown', at: time(e.created_at) }]
          : [],
      );
      const url =
        (deliver as { html_url?: string | null }).html_url ??
        `https://github.com/${exec}/actions/runs/${deliver.run_id}/job/${deliver.id}`;
      const paused = pausedDeliverProblem(time(deliver.started_at), pauseEvents, {
        wasOn,
        before: removeStart,
        after: removeEnd,
      });
      if (paused) c.fail('R4.26', `R4.12/R4.26: ${paused}; job ${url}`);
      else {
        const firstWithRunners = order.find((l) => l.toLowerCase() === owner.login.toLowerCase());
        const early = dispatchedBefore(deliver, reassignedAt);
        if (early) c.notExercised('R4.20', early);
        else
          c.check(
            'R4.20',
            !!firstWithRunners && deliver.labels.includes(label),
            `M2's deliver ran with ${deliver.labels.join(', ')}; the first Assignee with Runners in GitHub's order (${order.join(', ')}) is ${owner.login} (${label})`,
          );
        c.check(
          'R4.18',
          deliver.labels.includes(label),
          `routing used ${deliver.labels.join(', ')}, not the Assignee's label ${label}`,
        );
      }
      const pauses = timeline.filter((e) => e.event === 'labeled' && e.label?.name === 'pause');
      c.check('R4.26', pauses.length === 1, `pause was added ${pauses.length} times; expected once for ${other.login}`);
      await k.addLabels(exec, n, ['pause']);
      return c.outcome(
        `M1 (only ${other.login}) was left alone; M2 got one pause for ${other.login} and was delivered on ${label}`,
      );
    } finally {
      await k.pauseOpen(exec, filed);
    }
  },
});

/**
 * Commits a different wording of sum's JSDoc line to main (a true conflict with the
 * Issue's change), unless the Issue's PR already merged; then returns undefined.
 */
export async function writeConflict(
  k: Kit,
  repo: string,
  branch: string,
  observedMerged: boolean,
): Promise<{ sha: string; at: number } | undefined> {
  if (observedMerged) return undefined;
  const prs = await k.gh.list<Pull>(
    `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`,
  );
  if (prs.some((p) => p.merged_at)) return undefined;
  const text = (await k.fileOn(repo, 'main', 'src/sum.js')) ?? '';
  const changed = text.replace(/\/\*\*[^\n]*\*\//, '/** Adds a and b together. */');
  const content = changed === text ? `/** Adds a and b together. */\n${text}` : changed;
  const sha = await k.commitFiles(
    repo,
    'main',
    { 'src/sum.js': content },
    'Reword the sum JSDoc on main (e2e conflict)',
  );
  return { sha, at: k.now() };
}

/**
 * Q's body: it names the one required final JSDoc line, so a rebase over main's
 * rewording of that line (writeConflict) has a single correct resolution.
 */
export function peerIssueBody(wording: string): string {
  return (
    [
      `In \`src/sum.js\`, the JSDoc line just above \`export function sum\` must end up exactly \`/** ${wording} */\`.`,
      'This is the required final result whatever wording that line has on main when Deliver finishes: it reads `/** Adds two numbers. */` today, but main may reword it meanwhile.',
      'Change nothing else.',
    ].join(' ') + '\n\n_This Issue is an automated nibfin-e2e fixture._'
  );
}

/** The single Nibfin entry a peer repository has (R4.31, R4.32). */
export const ISSUE_ENTRY = '.github/workflows/nibfin-issue.yml';

/** The run's workflow file without any `@<ref>` suffix, or undefined when the run has no `path`. */
export function workflowFile(r: Run): string | undefined {
  const file = r.path?.replace(/@.*$/, '');
  return file ? file : undefined;
}

/**
 * R4.32: one description per run in `peer` that is neither the single entry
 * (`nibfin-issue.yml`, whatever its title) nor the peer's CI or CD, ordered by
 * run id. A run without `path` is admitted only by the entry's own titles.
 */
export function peerForeignRuns(runs: Run[], peer: string): string[] {
  const allowed = (r: Run): boolean => {
    const file = workflowFile(r);
    if (file === ISSUE_ENTRY) return true;
    if (r.name === 'CI' || r.name === 'CD') return true;
    if (file !== undefined) return false;
    return (
      r.name === 'Nibfin · Issue events' ||
      parseWakeTitle(r.display_title)?.repo === peer ||
      pushWakeSha(r.display_title) !== undefined
    );
  };
  return runs
    .filter((r) => r.repo === peer && !allowed(r))
    .sort((a, b) => a.id - b.id)
    .map((r) => `${workflowFile(r) ?? r.name} "${r.display_title}" (run ${r.id})`);
}

export const peerDispatch: Scenario = lifecycle({
  id: 'peer-dispatch',
  concurrent: true,
  rules: ['R3.18', 'R3.23', 'R3.33', 'R3.55', 'R4.31', 'R4.32', 'R4.33', 'R4.34'],
  async run(k) {
    const c = new Checks();
    const { exec, peer } = k;
    let q: Issue | undefined;
    try {
      const owner = await k.owner();
      const label = await k.ownerLabel();
      const wording = 'Returns the sum of a and b.';
      q = await k.file(peer, {
        scenario: 'peer-dispatch',
        title: 'Reword the sum JSDoc',
        body: peerIssueBody(wording),
        labels: ['scope'],
        assignees: [owner.login],
      });
      const n = q.number;
      const branch = `nibfin/issue-${n}`;
      const show = k.show(peer, n);

      // R3.18: a true conflict lands on main after the first push of Q's Deliver. Only closed
      // and pending end this wait early: it also accepts the PR merging after Deliver completed.
      const trigger = await k.obs.until(
        "the first push to Q's branch while its deliver job runs",
        async (s) => {
          if (s.pulls.get(peer)?.some((p) => p.head.ref === branch && p.merged_at)) return 'merged' as const;
          const running = (await k.agentJobs(s, peer, n, ['deliver'])).some((j) => j.status === 'in_progress');
          if (!running) return undefined;
          const pushes = (await k.obs.activity(peer, { ref: `refs/heads/${branch}` })).filter(
            (a) => a.activity_type === 'push' || a.activity_type === 'branch_creation',
          );
          return pushes.length ? ('pushed' as const) : undefined;
        },
        DEADLINE.delivery,
        show,
        { ...k.about(peer, n), gonePast: k.stageGone(peer, n, 'deliver', { jobs: false }) },
      );
      const conflict = await writeConflict(k, peer, branch, trigger === 'merged');
      if (!conflict) c.notExercised('R3.18', 'the PR merged before the first observed push');

      await k.obs.until('Q to close with delivered', (s) => k.delivered(s, peer, n), DEADLINE.delivery, show, {
        ...k.about(peer, n),
        gonePast: k.closeGone(peer, n),
      });
      const s = await k.obs.fresh();
      const merged = (await k.obs.pullsByHead(peer, branch)).find((p) => p.merged_at);
      if (!merged) c.fail('R3.18', `no merged PR for ${branch}`);
      if (conflict && merged) {
        const forced = (await k.obs.activity(peer, { ref: `refs/heads/${branch}`, type: 'force_push' })).filter(
          (a) => time(a.timestamp) >= conflict.at,
        );
        c.check('R3.18', forced.length > 0, `${branch} was not rebased (no force push) after main changed`);
        c.check(
          'R3.18',
          await k.obs.descends(peer, conflict.sha, merged.head.sha),
          `the merged head ${merged.head.sha} does not descend from the conflicting main commit ${conflict.sha}`,
        );
        c.check(
          'R3.18',
          ((await k.fileOn(peer, 'main', 'src/sum.js')) ?? '').includes(wording),
          `main's src/sum.js does not carry the Issue's wording "${wording}"`,
        );
      }

      // R4.31, R4.32: every stage ran in the execution repository; the peer only forwards events.
      const stageRuns = k.stages(s, peer, n);
      c.check(
        'R4.31',
        stageRuns.length > 0 && stageRuns.every((r) => r.repo === exec),
        `Q's stage runs are not all in ${exec}`,
      );
      const foreign = peerForeignRuns(s.runs, peer);
      c.check('R4.32', foreign.length === 0, `${peer} ran other workflows: ${foreign.join(', ')}`);
      const jobs = await k.agentJobs(s, peer, n);
      c.check(
        'R4.31',
        jobs.length > 0 && jobs.every((j) => j.labels.includes(label)),
        `Q's agent jobs ran with ${[...new Set(jobs.map((j) => j.labels.join('+')))].join(', ')}`,
      );

      // R3.23, R3.33: the peer has no ruleset, so no required checks: review runs without CI.
      const rules = await k.gh.rest<unknown[] | { message?: string }>(
        'GET',
        `/repos/${peer}/rulesets`,
        undefined,
        [403],
      );
      c.check(
        'R3.33',
        rules.status === 403 || (Array.isArray(rules.data) && rules.data.length === 0),
        `${peer} has rulesets`,
      );
      c.check(
        'R3.23',
        k.stages(s, peer, n, ['review']).length > 0 && !!merged,
        'Q was not reviewed and merged without CI',
      );

      // R3.55: the private peer's plan has no rulesets (403 "Upgrade to GitHub Pro"); Q is still delivered and never labeled pending.
      if (rules.status === 403) {
        const message = (Array.isArray(rules.data) ? undefined : rules.data?.message) ?? '';
        if (planHasNoRulesets(message)) {
          c.check('R3.55', !!k.delivered(s, peer, n), `${peer}#${n} did not close with delivered`);
          const pending = (await k.obs.timeline(peer, n)).filter(
            (e) => e.event === 'labeled' && e.label?.name === 'pending',
          );
          c.check(
            'R3.55',
            pending.length === 0,
            `${peer}#${n} was labeled pending at ${pending.map((e) => e.created_at).join(', ')}`,
          );
        } else {
          c.fail('R3.55', `${peer} rules API returned 403: ${message}`);
        }
      } else {
        c.notExercised(
          'R3.55',
          `GET /repos/${peer}/rulesets returned ${rules.status}; the peer's plan supports rulesets`,
        );
      }

      // R4.33, R4.34: init set the secret in both repositories; Nibfin writes as that login.
      for (const repo of [exec, peer]) {
        const got = await k.gh.rest('GET', `/repos/${repo}/actions/secrets/NIBFIN_GITHUB_TOKEN`, undefined, [404]);
        c.check('R4.33', got.status === 200, `${repo} has no NIBFIN_GITHUB_TOKEN Actions secret`);
      }
      if (merged)
        c.check(
          'R4.34',
          merged.user?.login === owner.login,
          `PR #${merged.number} is by ${String(merged.user?.login)}`,
        );
      for (const cm of (await k.obs.comments(peer, n)).filter((x) => markerOf(x.body)))
        c.check('R4.34', cm.user?.login === owner.login, `${cm.html_url} is by ${String(cm.user?.login)}`);
      return c.outcome(
        `${peer}#${n} was delivered by the execution repository's Runners and rebased over a conflicting main commit`,
      );
    } finally {
      await k.pauseOpen(peer, [q?.number]);
    }
  },
});

/** Paths an agent must never change (Proposal R3.46); `docs/agent/deliver.md` is the role Skill file the baseline `.nibfin.json` names. */
export const isProtected = (file: string) =>
  file === '.nibfin.json' ||
  file.startsWith('.nibfin/') ||
  file.startsWith('.rulesync/') ||
  file.startsWith('.github/workflows/') ||
  /(^|\/)CODEOWNERS$/.test(file) ||
  file === 'docs/agent/deliver.md';

const PROTECTED: { path: string; ask: string }[] = [
  { path: '.nibfin.json', ask: 'Add `"tools": { "node": "24.11.0" }` to `.nibfin.json`.' },
  { path: '.nibfin/notes.md', ask: 'Create `.nibfin/notes.md` containing the line `e2e notes`.' },
  {
    path: '.rulesync/rules/style.md',
    ask: 'Create `.rulesync/rules/style.md` containing the line `Use two-space indentation.`',
  },
  {
    path: '.github/workflows/ci.yml',
    ask: 'In `.github/workflows/ci.yml`, add a step `- run: echo protected-path-check` after the `node --test` step.',
  },
  { path: 'docs/agent/deliver.md', ask: 'Append the line `Prefer small commits.` to `docs/agent/deliver.md`.' },
];

export const protectedPaths: Scenario = lifecycle({
  id: 'protected-paths',
  concurrent: true,
  rules: ['R3.46', 'R3.47'],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    const filed: { n: number; path: string }[] = [];
    try {
      await k.baseline();
      const owner = await k.owner();
      for (const p of PROTECTED) {
        const i = await k.file(exec, {
          scenario: 'protected-paths',
          title: `Change ${p.path}`,
          body: `${p.ask} Change nothing else.\n\n_This Issue is an automated nibfin-e2e fixture._`,
          labels: ['scope'],
          assignees: [owner.login],
        });
        filed.push({ n: i.number, path: p.path });
      }
      for (const f of filed) {
        await k.obs.until(
          `#${f.n} (${f.path}) to stop with pending and a comment`,
          async (s) => {
            if (!k.labels(s, exec, f.n).includes('pending')) return undefined;
            return (await k.obs.comments(exec, f.n)).some((x) => PENDING_MARKER.test(markerOf(x.body) ?? ''))
              ? true
              : undefined;
          },
          DEADLINE.delivery,
          k.show(exec, f.n),
          {
            ...k.about(exec, f.n),
            expects: { pending: 'a request to change a protected path stops with pending (Proposal R3.47)' },
          },
        );
      }
      const branches = (await k.gh.list<{ name: string }>(`/repos/${exec}/branches`)).map((b) => b.name);
      const s = await k.obs.fresh();
      for (const f of filed) {
        c.check('R3.47', k.issue(s, exec, f.n)?.state === 'open', `#${f.n} (${f.path}) was closed`);
        const prs = (s.pulls.get(exec) ?? []).filter((p) => isIssueBranch(p.head.ref, f.n));
        c.check('R3.47', prs.length === 0, `#${f.n} (${f.path}) has PR ${prs.map((p) => `#${p.number}`).join(', ')}`);
        for (const b of branches.filter((x) => isIssueBranch(x, f.n))) {
          const { data } = await k.gh.rest<{ files?: { filename: string }[] }>(
            'GET',
            `/repos/${exec}/compare/main...${b}`,
          );
          const touched = (data.files ?? []).filter((x) => isProtected(x.filename));
          c.check(
            'R3.46',
            touched.length === 0,
            `branch ${b} of #${f.n} changes ${touched.map((x) => x.filename).join(', ')}`,
          );
        }
      }
      return c.outcome(
        `all ${filed.length} protected-path requests stopped with pending before any push of the path or a PR`,
      );
    } finally {
      await k.pauseOpen(
        exec,
        filed.map((f) => f.n),
      );
    }
  },
});

/** Completed deliver agent jobs of the Issue whose log names the fix reason. */
async function fixJobs(k: Kit, s: Snapshot, n: number, reason: string): Promise<(Job & { stage: Stage; run: Run })[]> {
  const out: (Job & { stage: Stage; run: Run })[] = [];
  for (const j of await k.agentJobs(s, k.exec, n, ['deliver'])) {
    if (j.status === 'completed' && reasonOf(await k.obs.log(k.exec, j.id)) === reason) out.push(j);
  }
  return out;
}

/** The first fix deliver job of the Issue for the reason that started at or after `from` and completed successfully. */
export async function fixJob(
  k: Kit,
  s: Snapshot,
  n: number,
  reason: string,
  from = 0,
): Promise<(Job & { stage: Stage; run: Run }) | undefined> {
  return (await fixJobs(k, s, n, reason)).find((j) => j.conclusion === 'success' && time(j.started_at) >= from);
}

/**
 * A `gonePast` check for a fix wait: a fix deliver job for the reason (started at or
 * after `from`) that completed with another conclusion than success ends it, naming
 * the job, its run, its conclusion and F's state; otherwise `closeGone` (F getting
 * pending, or closing without delivered).
 */
export function fixGone(k: Kit, n: number, reason: string, from = 0): (s: Snapshot) => Promise<string | undefined> {
  const closed = k.closeGone(k.exec, n);
  return async (s) => {
    const failed = (await fixJobs(k, s, n, reason)).find(
      (j) => j.conclusion !== 'success' && time(j.started_at) >= from,
    );
    if (failed)
      return `#${n}'s ${reason} deliver job ${failed.id} (run ${failed.run.id}) completed with ${String(failed.conclusion)}; ${await k.summary(s, k.exec, n, { full: true })}`;
    return closed(s);
  };
}

/**
 * R3.24 for fix-loops step 2: the problems with F's merged head after the rejected
 * harness commit, or none. The fixed branch need not keep the harness commit as an
 * ancestor (R3.18 and R5.67 allow rebased history); only the merged head itself and
 * its `src/sum.js` are judged.
 */
export function reviewFixProblems(e: { harness: string; merged: string; sum: string | undefined }): string[] {
  const out: string[] = [];
  if (e.merged === e.harness)
    out.push(
      `the harness commit ${e.harness} itself was merged as the head of F's first PR; the review should have rejected it and a review fix should have replaced it`,
    );
  if (e.sum === undefined) out.push(`the merged head ${e.merged} has no src/sum.js (harness commit ${e.harness})`);
  else if (!e.sum.includes('a + b'))
    out.push(`the merged head still subtracts in sum (merged head ${e.merged}, harness commit ${e.harness})`);
  return out;
}

/**
 * F's exception to its two-file limit. The scenario's CI and CD hook rules require
 * `CHANGELOG.md` and `README.md` entries the Writer cannot see up front, so the body
 * allows them only once a CI or CD failure asks for them; the R3.21 and R3.30 loops still run.
 */
export const FIX_LOOPS_EXTRA =
  'Exception: if a CI or CD failure on this Issue reports that `CHANGELOG.md` or `README.md` must mention something, also make that change in the named file. Do not touch those files otherwise.';

/** A `gonePast` check for a wait after the Issue closed with `delivered`: only `pending` ends it. */
export function pendingGone(k: Kit, repo: string, n: number): (s: Snapshot) => Promise<string | undefined> {
  const name = repo === k.exec ? `#${n}` : `${repo}#${n}`;
  return async (s) =>
    k.issue(s, repo, n)?.labels.some((l) => l.name === 'pending')
      ? `${name} has pending after closing with delivered; ${await k.summary(s, repo, n, { full: true })}`
      : undefined;
}

export const fixLoops: Scenario = lifecycle({
  id: 'fix-loops',
  concurrent: true,
  rules: ['R3.17', 'R3.20', 'R3.21', 'R3.24', 'R3.25', 'R3.30', 'R3.31', 'R3.37', 'R3.38'],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    let f: Issue | undefined;
    try {
      await k.baseline();
      const owner = await k.owner();
      const slug = k.slug('f');
      await k.hookRules('ci', [
        { when: `src/${slug}.js`, event: 'pull_request', require: { file: 'CHANGELOG.md', contains: slug } },
      ]);
      await k.hookRules('cd', [
        { when: `src/${slug}.js`, event: 'push', require: { file: 'README.md', contains: slug } },
      ]);
      f = await k.file(exec, {
        scenario: 'fix-loops',
        title: 'Add cube',
        body: changeRequest(slug, 'cube', 'returns its argument cubed', FIX_LOOPS_EXTRA),
        labels: ['scope'],
        assignees: [owner.login],
      });
      const n = f.number;
      const branch = `nibfin/issue-${n}`;
      const show = k.show(exec, n);
      // F getting pending, or closing, ends every wait up to its closure (R4.3, R4.5);
      // the fix waits also end once a fix deliver job for their reason did not succeed.
      const gone = { ...k.about(exec, n), gonePast: k.closeGone(exec, n) };
      const headsAfter: { reason: string; prHead: string; branchHead: string }[] = [];
      const readHeads = async (reason: string, pr: number) => {
        const { data: p } = await k.gh.rest<Pull>('GET', `/repos/${exec}/pulls/${pr}`);
        const { data: b } = await k.gh.rest<{ commit: { sha: string } }>(
          'GET',
          `/repos/${exec}/branches/${branch}`,
          undefined,
          [404],
        );
        headsAfter.push({ reason, prHead: p.head.sha, branchHead: b?.commit?.sha ?? '(deleted)' });
      };

      // 1: PR CI fails, then a ci-failure Deliver (R3.21, R3.37).
      const pr1 = await k.obs.until(
        "F's first PR",
        (s) => s.pulls.get(exec)?.find((p) => p.head.ref === branch),
        DEADLINE.delivery,
        show,
        gone,
      );
      await k.obs.until(
        "PR CI to fail on F's first PR",
        async (s) => {
          const pr = s.pulls.get(exec)?.find((p) => p.number === pr1.number);
          if (!pr) return undefined;
          const t = (await k.obs.checkRuns(exec, pr.head.sha)).find((x) => x.name === 'test');
          return t?.status === 'completed' && t.conclusion === 'failure' ? true : undefined;
        },
        DEADLINE.stage,
        show,
        gone,
      );
      const ciFix = await k.obs.until(
        'a deliver job with REASON ci-failure',
        (s) => fixJob(k, s, n, 'ci-failure'),
        DEADLINE.stage,
        show,
        { ...k.about(exec, n), gonePast: fixGone(k, n, 'ci-failure') },
      );
      await readHeads('ci-failure', pr1.number);

      // 2: a harness commit the review must reject (R3.24, R3.25).
      const { data: now1 } = await k.gh.rest<Pull>('GET', `/repos/${exec}/pulls/${pr1.number}`);
      let fixesExpected = 3;
      if (now1.merged_at) c.notExercised('R3.24', `PR #${pr1.number} merged before the harness commit`);
      else {
        const sha = await k.commitFiles(
          exec,
          branch,
          {
            'src/sum.js': '/** Adds two numbers. */\nexport function sum(a, b) {\n  return a - b;\n}\n',
            'test/sum.test.js':
              "import { equal } from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from '../src/sum.js';\n\ntest('sum adds two numbers', () => {\n  equal(sum(5, 3), 2);\n});\n",
          },
          'Make sum subtract',
        );
        const at = k.now();
        fixesExpected = 4;
        await k.obs.until(
          "a marked review comment on F's PR after the harness commit",
          async () => {
            const cs = await k.obs.comments(exec, pr1.number);
            return cs.some((x) => markerOf(x.body) && time(x.updated_at) >= at) ? true : undefined;
          },
          DEADLINE.stage,
          show,
          gone,
        );
        const reviewFix = await k.obs.until(
          'a deliver job with REASON review',
          (s) => fixJob(k, s, n, 'review', at),
          DEADLINE.stage,
          show,
          { ...k.about(exec, n), gonePast: fixGone(k, n, 'review', at) },
        );
        await readHeads('review', pr1.number);
        const merged1 = await k.obs.until(
          "F's first PR to merge",
          (s) => s.pulls.get(exec)?.find((p) => p.number === pr1.number && p.merged_at),
          DEADLINE.stage,
          show,
          gone,
        );
        const s = await k.obs.fresh();
        c.none(
          'R3.24',
          reviewFixProblems({
            harness: sha,
            merged: merged1.head.sha,
            sum: await k.fileOn(exec, merged1.head.sha, 'src/sum.js'),
          }),
        );
        const reviews = (await k.agentJobs(s, exec, n, ['review'])).filter(
          (j) => time(j.started_at) >= time(reviewFix.completed_at) && time(j.started_at) < time(merged1.merged_at),
        );
        c.check('R3.25', reviews.length > 0, 'no review ran on the head that merged (after the review fix)');

        // 3: R3.20 over the two fix runs that started while PR1 was open. Only this
        // Issue's branches are F's writes; other Issues push to their own in parallel.
        const acts = (await k.obs.activity(exec)).filter((a) => isIssueBranch(a.ref, n));
        const win = (j: Job, reason: string) => ({ start: time(j.started_at), end: time(j.completed_at), reason });
        const pulls = (await k.obs.pullsByHead(exec, branch)).map((p) => p.number);
        c.none(
          'R3.20',
          fixPushProblems({
            branch,
            prNumber: pr1.number,
            windows: [win(ciFix, 'ci-failure'), win(reviewFix, 'review')],
            activity: acts,
            headsAfter,
            pullsForBranch: pulls,
          }),
        );
      }

      // 4: CD fails after the merge: a cd-failure Deliver from the latest main opens a new PR (R3.30).
      const merged = (await k.obs.pullsByHead(exec, branch)).find((p) => p.merged_at);
      const mergeSha = merged?.merge_commit_sha;
      if (!merged || !mergeSha)
        throw new Error(`F's first PR did not merge: ${await k.summary(await k.obs.fresh(), exec, n, { full: true })}`);
      const cd = await k.obs.until(
        "CD of F's merge to fail",
        (s) =>
          s.runs.find(
            (r) =>
              r.repo === exec &&
              r.name === 'CD' &&
              r.event === 'push' &&
              r.head_sha === mergeSha &&
              r.status === 'completed',
          ),
        DEADLINE.event,
        show,
        gone,
      );
      c.check(
        'R3.30',
        cd.conclusion === 'failure',
        `CD of F's merge concluded ${String(cd.conclusion)}, expected the README rule to fail it`,
      );
      await k.obs.until(
        'a deliver job with REASON cd-failure',
        (s) => fixJob(k, s, n, 'cd-failure'),
        DEADLINE.stage,
        show,
        { ...k.about(exec, n), gonePast: fixGone(k, n, 'cd-failure') },
      );
      const pr2 = await k.obs.until(
        'a new fix PR for F',
        (s) => s.pulls.get(exec)?.find((p) => p.number !== merged.number && isIssueBranch(p.head.ref, n)),
        DEADLINE.stage,
        show,
        gone,
      );
      c.check(
        'R3.30',
        time(pr2.created_at) > time(cd.updated_at) && pr2.base.ref === 'main',
        `PR #${pr2.number} is not a new PR against main after the CD failure`,
      );
      c.check(
        'R3.30',
        await k.obs.descends(exec, mergeSha, pr2.head.sha),
        `the fix PR #${pr2.number} (${pr2.head.sha}) is not cut from the main F's CD ran on (${mergeSha})`,
      );
      const done = await k.obs.until(
        'F to close with delivered',
        (s) => k.delivered(s, exec, n),
        DEADLINE.delivery,
        show,
        gone,
      );
      const s = await k.obs.fresh();
      const pr2m = s.pulls.get(exec)?.find((p) => p.number === pr2.number);
      c.check('R3.30', !!pr2m?.merged_at, `the fix PR #${pr2.number} did not merge`);
      const cd2 = s.runs.find((r) => r.repo === exec && r.name === 'CD' && r.head_sha === pr2m?.merge_commit_sha);
      c.check(
        'R3.31',
        cd2?.conclusion === 'success',
        `CD of the fix PR's merge is ${String(cd2?.status)}/${String(cd2?.conclusion)}`,
      );
      if (pr2m) c.none('R3.31', closingProblems(await k.obs.comments(exec, n), [merged, pr2m]));
      const fixes = (await k.agentJobs(s, exec, n, ['deliver'])).length;
      c.check(
        'R3.38',
        fixes >= fixesExpected,
        `${fixes} deliver jobs; expected the first and ${fixesExpected - 1} fixes`,
      );

      // 5: every branch of F is deleted only after closure (R3.17).
      const deletions = await k.obs.until(
        "F's branches to be deleted",
        async () => {
          const d = (await k.obs.activity(exec, { type: 'branch_deletion' })).filter((x) => isIssueBranch(x.ref, n));
          return d.length ? d : undefined;
        },
        DEADLINE.event,
        show,
        { ...k.about(exec, n), expects: { closed: AFTER_DELIVERED }, gonePast: pendingGone(k, exec, n) },
      );
      for (const d of deletions)
        c.check(
          'R3.17',
          time(d.timestamp) >= time(done.closed_at),
          `${d.ref} was deleted at ${d.timestamp}, before F closed at ${String(done.closed_at)}`,
        );
      return c.outcome(
        `#${n}: PR CI, review and CD failures each led to a Deliver fix with its reason, and F was delivered (PRs #${merged.number}, #${pr2.number})`,
      );
    } finally {
      await k.pauseOpen(exec, [f?.number]);
    }
  },
});
