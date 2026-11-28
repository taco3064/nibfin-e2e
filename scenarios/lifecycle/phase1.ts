// Phase 1: scenarios that change the whole host (the login, the Runner services), so
// each runs alone.
import type { Scenario } from '../../src/types.ts';
import {
  AGENT_STAGES,
  Checks,
  describeJob,
  duplicateMarkers,
  githubHosted,
  jobWindow,
  markerOf,
  overlap,
  queuedHoldProblems,
  ranOnRunner,
  selfHosted,
  startedBefore,
  time,
} from './analysis.ts';
import type { Comment, Issue, Job, Run, Runner, Stage } from './analysis.ts';
import { DEADLINE, changeRequest, finishAt, hostedRunProblems, stageSeen, lifecycle, message, redact } from './kit.ts';
import type { Kit } from './kit.ts';
import { stageJobRunning } from './journeys.ts';
import { AWAITS_REVIEW, RELOGIN, SHAPE_MARKER } from './marks.ts';
import type { Snapshot } from './observe.ts';
import { runnerCount } from '../lib/github.ts';
import { runnerSlot, setSlotServices, slotsOf } from '../lib/runners.ts';

/** The closing comment names the PR and its merge commit as GitHub records them (Proposal R1.13, R3.31). */
export function closingProblems(
  comments: Comment[],
  prs: { number: number; html_url: string; merge_commit_sha: string | null }[],
): string[] {
  const marked = comments.filter((c) => markerOf(c.body));
  const closing = marked.at(-1);
  if (!closing) return ['no marked closing comment'];
  const body = closing.body ?? '';
  const out: string[] = [];
  for (const pr of prs) {
    if (!body.includes(`#${pr.number}`) && !body.includes(pr.html_url))
      out.push(`the closing comment does not name PR #${pr.number}`);
    const sha = pr.merge_commit_sha;
    if (!sha) out.push(`PR #${pr.number} has no merge commit on GitHub`);
    else if (!body.includes(sha.slice(0, 7)))
      out.push(`the closing comment does not name merge commit ${sha.slice(0, 7)} of PR #${pr.number}`);
  }
  return out;
}

/** The marked PR comment saying the merge waits for an approving review (Proposal R3.26), written or updated at or after `since`. */
export function awaitingReview(comments: Comment[], since: number): Comment | undefined {
  return comments.find((x) => markerOf(x.body) && AWAITS_REVIEW.test(x.body ?? '') && time(x.updated_at) >= since);
}

/** A ruleset rule requiring one approving review; an approval stays valid after a push. */
export const APPROVAL_RULE = {
  type: 'pull_request',
  parameters: {
    required_approving_review_count: 1,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_review_thread_resolution: false,
  },
};

/**
 * Why the redone shape run does not count as a redo (Proposal R1.12): it has no
 * self-hosted agent job that ran on a Runner and concluded `success`. Undefined when it has one.
 */
export function redoneShapeProblem(run: Pick<Run, 'id' | 'conclusion'>, jobs: Job[]): string | undefined {
  const agent = jobs.filter((j) => selfHosted(j) && ranOnRunner(j));
  if (agent.some((j) => j.conclusion === 'success')) return undefined;
  const last = agent.at(-1);
  if (last)
    return `the redone shape run ${run.id} (${String(run.conclusion)}): its agent job ${last.id} concluded ${String(last.conclusion)}`;
  const list = jobs
    .map((j) => `${j.name} (runner ${j.runner_name ?? 'none'}, ${j.status}/${j.conclusion ?? 'none'})`)
    .join('; ');
  return `the redone shape run ${run.id} concluded ${String(run.conclusion)} with no agent job that ran on a Runner; jobs: ${list || 'none'}`;
}

/**
 * A `gonePast` check for login-expiry's waits after the re-login (Proposal R1.14): the Issue
 * gained `pause` or `pending` the scenario did not add. The scenario adds neither during
 * these waits, and its token may be the Owner's, so a label is told apart by time, not by
 * login: any `pause`, and a `pending` labeled at or after `after` (when the scenario
 * removed `pending`). The reason names the label, when and by whom, from the timeline; a
 * `pause` not yet on the timeline ends the wait one snapshot later. Otherwise undefined,
 * so `stageGone`'s own reasons still apply.
 */
export function foreignLabelGone(
  k: Kit,
  repo: string,
  n: number,
  after: number,
): (s: Snapshot) => Promise<string | undefined> {
  const since = Math.floor(after / 1000) * 1000;
  let pauseSeen: number | undefined;
  const labeled = async (label: string, from: number) =>
    (await k.obs.timeline(repo, n))
      .filter((e) => e.event === 'labeled' && e.label?.name === label && time(e.created_at) >= from)
      .at(-1);
  const by = (e: { actor?: { login: string } | null }) => e.actor?.login ?? 'unknown';
  return async (s) => {
    const reason = await (async () => {
      const labels = k.labels(s, repo, n);
      if (labels.includes('pause')) {
        const e = await labeled('pause', 0);
        if (e)
          return `#${n} gained pause at ${new Date(time(e.created_at)).toISOString()} by ${by(e)}, which the scenario did not add`;
        if (pauseSeen === undefined) {
          pauseSeen = s.at;
          return undefined;
        }
        return `#${n} gained pause, first seen at ${new Date(pauseSeen).toISOString()}, by an actor not yet on the timeline, which the scenario did not add`;
      }
      pauseSeen = undefined;
      if (labels.includes('pending')) {
        const e = await labeled('pending', since);
        if (e) return `#${n} has pending, added at ${new Date(time(e.created_at)).toISOString()} by ${by(e)}`;
      }
      return undefined;
    })();
    return reason === undefined ? undefined : redact(reason, k.ctx.secretValues());
  };
}

/** Why login-expiry's first waits do not end on `pending`: the invalid login fails the shape and Nibfin adds it (Proposal R6.13). */
const LOGIN_PENDING = 'the shape fails on the invalid login and Nibfin adds pending';

export const loginExpiry: Scenario = lifecycle({
  id: 'login-expiry',
  rules: ['R6.13', 'R1.12', 'R3.42', 'R3.43'],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    let issue: Issue | undefined;
    let invalid = false;
    try {
      invalid = true;
      await k.ctx.claudeLogin('invalid');
      const owner = await k.owner();
      issue = await k.file(exec, {
        scenario: 'login-expiry',
        title: 'Add increment',
        body: changeRequest(k.slug('l'), 'increment', 'returns its argument plus one'),
        labels: ['scope'],
        assignees: [owner.login],
      });
      const n = issue.number;
      const show = k.show(exec, n);
      await k.obs.until(
        'the shape job to fail on the invalid login',
        async (s) =>
          (await k.agentJobs(s, exec, n, ['shape'])).find(
            (j) => j.status === 'completed' && j.conclusion === 'failure',
          ),
        DEADLINE.stage,
        show,
        { ...k.about(exec, n), expects: { pending: LOGIN_PENDING } },
      );
      await k.obs.until(
        '`pending` and a comment naming the re-login command',
        async (s) => {
          if (!k.labels(s, exec, n).includes('pending')) return undefined;
          return (await k.obs.comments(exec, n)).find(
            (x) => markerOf(x.body) && RELOGIN.test(x.body ?? '') && /claude/i.test(x.body ?? ''),
          );
        },
        DEADLINE.event,
        show,
        { ...k.about(exec, n), expects: { pending: LOGIN_PENDING } },
      );

      await k.ctx.claudeLogin('valid');
      invalid = false;
      await k.removeLabel(exec, n, 'pending');
      const woke = k.now();
      const next = await k.obs.until(
        'the next agent stage run',
        (s) => k.stages(s, exec, n, AGENT_STAGES).find((r) => time(r.created_at) >= woke),
        DEADLINE.stage,
        show,
        k.about(exec, n),
      );
      c.check(
        'R6.13',
        next.stage === 'shape',
        `after re-login the first agent stage run is ${next.stage}, expected the failed stage shape`,
      );
      c.check(
        'R3.43',
        next.stage === 'shape',
        `removing pending (a legal event) led to ${next.stage}, not a redo of shape`,
      );
      // No `pause` until `shaped`: Core reads the Issue when it starts and again before it
      // publishes, and a paused Issue is not published (Proposal R4.12, R4.35).
      // A `pause` or `pending` the scenario did not add ends both waits at once (Proposal R1.14).
      const gone = k.stageGone(exec, n, 'shape', { since: woke - 60_000, publishes: 'shaped' });
      const foreign = foreignLabelGone(k, exec, n, woke);
      const exit = async (s: Snapshot) => (await foreign(s)) ?? (await gone(s));
      const done = await k.obs.until(
        'the redone shape run to complete',
        (s) => s.runs.find((r) => r.id === next.id && r.status === 'completed'),
        DEADLINE.stage,
        show,
        { ...k.about(exec, n), gonePast: exit },
      );
      // R1.12 counts the redone run's agent job, not the run: a run whose agent job never ran also concludes success.
      const r112 = redoneShapeProblem(done, await k.obs.jobs(exec, done.id));
      if (r112) {
        c.fail('R1.12', r112);
        c.notExercised('R3.42', 'the redone shape run published nothing to check');
        return c.outcome(
          `#${n}: shape failed on an invalid login with pending and a re-login comment; after re-login the redone shape did not run`,
        );
      }
      await k.obs.until(
        '`shaped`',
        (s) => (k.labels(s, exec, n).includes('shaped') ? true : undefined),
        DEADLINE.event,
        show,
        { ...k.about(exec, n), gonePast: exit },
      );
      await k.addLabels(exec, n, ['pause']);
      const comments = await k.obs.comments(exec, n);
      const shapes = comments.filter((x) => SHAPE_MARKER.test(markerOf(x.body) ?? ''));
      c.check('R3.42', shapes.length === 1, `#${n} has ${shapes.length} marked Shape comments, expected exactly one`);
      c.none(
        'R3.42',
        duplicateMarkers(comments).map((d) => `#${n} has the marked comment ${d}`),
      );
      return c.outcome(
        `#${n}: shape failed on an invalid login with pending and a re-login comment; after re-login and removing pending, shape was redone once`,
      );
    } finally {
      if (invalid)
        await k.ctx
          .claudeLogin('valid')
          .catch((e: unknown) => k.ctx.log(`restoring the Claude login failed: ${message(e)}`));
      await k.pauseOpen(exec, [issue?.number]);
    }
  },
});

/** A queued shape job of the Issue on the label, or a sign that it already started. */
async function dispatched(
  k: Kit,
  s: Snapshot,
  n: number,
  label: string,
): Promise<{ queued?: Job & { run: Run }; started?: Job } | undefined> {
  if (!k.stages(s, k.exec, n, ['route']).some((r) => r.status === 'completed')) return undefined;
  const jobs = (await k.stageJobs(s, k.exec, n, ['shape'])).filter(selfHosted);
  const started = jobs.find((j) => j.status !== 'queued');
  if (started) return { started };
  const queued = jobs.find((j) => j.labels.includes(label) && !j.runner_name);
  return queued ? { queued } : undefined;
}

/**
 * Waits for Issue `n`'s deliver job to be `in_progress` while `nibfin/issue-<n>` is at
 * least one commit ahead of `main`, and returns that job with the branch head read then.
 * The wait watches I, so a short deliver job is still seen, and the branch is read
 * directly again on each watched read while the job runs without a commit. The wait fails at once
 * when the job completed before a read saw it running, or completed after one did but
 * before a read saw a commit (Issue #581).
 */
export async function deliverWithCommits(
  k: Kit,
  n: number,
  o: { since: number; show?: (s: Snapshot) => Promise<string> },
): Promise<{ oldJob: Job & { stage: Stage; run: Run }; h1: string }> {
  const branch = `nibfin/issue-${n}`;
  let h1: string | undefined;
  const oldJob = await stageJobRunning(k, n, 'deliver', {
    desc: "I's deliver job to run with commits on its branch",
    deadlineMs: DEADLINE.stage,
    show: o.show,
    who: 'I',
    since: o.since,
    whileRunning: {
      what: 'a read saw a commit on its branch',
      check: async () => {
        const at = new Date(k.now()).toISOString();
        const cmp = await k.gh.rest<{ ahead_by: number }>('GET', `/repos/${k.exec}/compare/main...${branch}`, undefined, [404]);
        if (cmp.status === 404) return { ok: false, last: `the branch was last read at ${at}: not found (404)` };
        if (cmp.data.ahead_by < 1) return { ok: false, last: `the branch was last read at ${at}: ${cmp.data.ahead_by} commits ahead of main` };
        const { data } = await k.gh.rest<{ commit: { sha: string } }>('GET', `/repos/${k.exec}/branches/${branch}`);
        h1 = data.commit.sha;
        return { ok: true };
      },
    },
  });
  if (h1 === undefined) throw new Error(`I's deliver job ${oldJob.id} was returned without a branch head`);
  return { oldJob, h1 };
}

/**
 * The one Runner slot interrupted-deliver keeps active: I's deliver job alone must keep
 * every active Runner busy so that I3's shape job, dispatched to the busy but online
 * member, queues behind it (Proposal R4.23, R4.20). Every other slot is stopped for the
 * scenario's run.
 */
const ACTIVE_SLOTS = ['claude-1'];

/**
 * The registration name of the one active Runner, read from the registrations after the
 * other slots were stopped. A stopped slot whose registration still reads online does not
 * count, because the Runners are matched by slot. Throws, naming every registration read,
 * unless exactly one registration belongs to an active slot.
 */
export function activeRunner(rs: readonly Runner[]): string {
  const active = rs.filter((r) => ACTIVE_SLOTS.includes(runnerSlot(r.name) ?? ''));
  if (active.length === 1) return (active[0] as Runner).name;
  const read = rs.map((r) => `${r.name} (slot ${runnerSlot(r.name) ?? 'none'}, ${r.status}, ${r.busy ? 'busy' : 'idle'})`);
  throw new Error(
    `interrupted-deliver needs exactly one active Runner (${ACTIVE_SLOTS.join(', ')}); the registrations read are ${read.join(', ') || 'none'}`,
  );
}

/**
 * Waits for I's deliver job to be seen `in_progress` and returns it, so that I3 is filed
 * while that job alone holds the active Runner. It needs no commit on I's branch, and it
 * fails at once, naming the job's times, when the job completed before any read saw it running.
 */
export function deliverStarted(
  k: Kit,
  n: number,
  o: { since: number; show?: (s: Snapshot) => Promise<string> },
): Promise<Job & { stage: Stage; run: Run }> {
  return stageJobRunning(k, n, 'deliver', {
    desc: "I's deliver job to start",
    deadlineMs: DEADLINE.stage,
    who: 'I',
    since: o.since,
    show: o.show,
  });
}

/** Whether every registered Runner was busy with one of the jobs at `t`, from the jobs' own windows. */
export function allBusyAt(t: number, jobs: Job[], runners: string[]): boolean {
  const windows = jobs.flatMap((j) => jobWindow(j, '', 'shape') ?? []);
  return (
    runners.length > 0 && runners.every((name) => windows.some((w) => w.runner === name && w.start <= t && t <= w.end))
  );
}

/**
 * Why I3's shape job can no longer be seen queued while I's deliver job holds the active
 * Runner: I's job completed first. Names I's job and its completion time, and I3's shape
 * job (`undefined` when none was read) with its state and times as read at `at`.
 * `undefined` while I's job has not completed.
 */
export function i3Missed(old: Job, i3Shape: Job | undefined, at: number): string | undefined {
  if (old.status !== 'completed') return undefined;
  const readAt = new Date(at).toISOString();
  const i3 = !i3Shape
    ? `I3's shape job was not yet seen when read at ${readAt}`
    : i3Shape.status === 'queued'
      ? `I3's shape job ${i3Shape.id} was queued (created ${i3Shape.created_at ?? 'none'}) when read at ${readAt}`
      : i3Shape.status === 'completed'
        ? `I3's shape job ${i3Shape.id} had started at ${i3Shape.started_at ?? 'none'} on ${String(i3Shape.runner_name)} and completed at ${i3Shape.completed_at ?? 'none'} when read at ${readAt}`
        : `I3's shape job ${i3Shape.id} was ${i3Shape.status}, started at ${i3Shape.started_at ?? 'none'} on ${String(i3Shape.runner_name)}, when read at ${readAt}`;
  return `I's deliver job ${old.id} completed at ${String(old.completed_at)} before I3's shape job was seen queued while it ran; ${i3}`;
}

export const interruptedDeliver: Scenario = lifecycle({
  id: 'interrupted-deliver',
  rules: [
    'R3.41',
    'R3.44',
    'R1.11',
    'R1.12',
    'R1.13',
    'R3.25',
    'R3.26',
    'R3.42',
    'R3.43',
    'R4.21',
    'R4.23',
    'R4.25',
    'R5.72',
    'R5.74',
  ],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    const filed: number[] = [];
    try {
      // Every slot but claude-1 is stopped, so that I's deliver job alone keeps the only active Runner
      // busy and I3's shape job queues behind it; the finally's runnerServices('start') starts them again.
      const extra = slotsOf(runnerCount(k.ctx.facts)).filter((s) => !ACTIVE_SLOTS.includes(s));
      if (extra.length) await setSlotServices(k.ctx.exec, k.ctx.browserEnv(), 'stop', extra);
      const runnerNames = [activeRunner(await k.obs.runners(exec))];
      const owner = await k.owner();
      const label = await k.ownerLabel();
      await k.ruleset('e2e-approval', [APPROVAL_RULE]);
      const slug = k.slug('i');
      const file = async (kind: string, title: string, body: string) => {
        const i = await k.file(exec, {
          scenario: 'interrupted-deliver',
          title,
          body,
          labels: ['scope'],
          assignees: [owner.login],
        });
        filed.push(i.number);
        return i.number;
      };
      const iFiledAt = k.now();
      const n = await file(
        'i',
        'Add clamp and document it',
        [
          `Add \`src/${slug}.js\` exporting \`clamp(n, lo, hi)\`, which returns \`n\` limited to the range \`lo\`..\`hi\`, with a \`node:test\` test in \`test/${slug}.test.js\`.`,
          'Then add a short "clamp" section to `README.md` describing it.',
          'Commit the function with its test first and the README section in a second commit. Change nothing else.',
          '_This Issue is an automated nibfin-e2e fixture._',
        ].join('\n\n'),
      );
      const branch = `nibfin/issue-${n}`;
      const show = k.show(exec, n);
      // I3 is filed as soon as I's deliver job is seen running, so that I3's shape job is dispatched
      // while that job alone holds the only active Runner. A deliver job that completed before any
      // read saw it running ends the wait at once with its times.
      await deliverStarted(k, n, { since: iFiledAt - 60_000, show });
      const n3 = await file('i3', 'Add sign', changeRequest(k.slug('i3'), 'sign', 'returns -1, 0 or 1 for the sign of its argument'));

      // 3: I's Deliver runs and has pushed to its branch. The wait re-reads the same job and watches I,
      // so a short Deliver is still seen, and a job that ends before a read saw it running with a commit
      // ends the wait at once (Issue #581).
      const { oldJob, h1 } = await deliverWithCommits(k, n, { since: iFiledAt - 60_000, show });

      // 5: I3 is dispatched while the member is online and busy; its job queues behind I's (R4.23, R4.20).
      // I's job completing first means the queue was never seen, and that is reported by name.
      const d3 = await k.obs.until(
        "I3's shape job to queue on the Owner's label while I's deliver job holds the only active Runner",
        async (s) => {
          // The job is re-read until it completes.
          const old = await k.obs.job(exec, oldJob.id);
          const d = await dispatched(k, s, n3, label);
          if (d?.queued && allBusyAt(s.at, [old], runnerNames)) return d;
          const missed = old.status === 'completed' ? i3Missed(old, (await k.stageJobs(s, exec, n3, ['shape'])).find(selfHosted), s.at) : undefined;
          if (missed) return { missed, old };
          return d?.started ? d : undefined;
        },
        DEADLINE.event,
        k.show(exec, n, n3),
        {
          ...k.about(exec, n, n3),
          gonePast: k.stageGone(exec, n3, 'shape'),
          watch: [k.watch(exec, n), k.watch(exec, n3)],
        },
      );
      if ('missed' in d3) {
        c.notExercised('R4.23', d3.missed);
        await k.addLabels(exec, n3, ['pause']);
        c.notExercised(
          'R3.41',
          `I's deliver job ${oldJob.id} completed at ${String(d3.old.completed_at)} before the Runners could be stopped, so no Deliver was interrupted`,
        );
        return c.outcome('interrupted-deliver');
      }
      const recordedAt = k.now();
      let j3 = d3.queued;
      const notExercised = async () => {
        c.notExercised('R4.23', 'the queued job started before the Runners went offline');
        j3 = undefined;
        await k.addLabels(exec, n3, ['pause']);
      };
      if (!j3) await notExercised();

      // 6: the member goes offline.
      await k.ctx.runnerServices('stop');
      const stopAt = k.now();
      await k.ctx.stopJobContainers(exec, n);
      await k.obs.until(
        'every Runner registration to read offline',
        async () => {
          const rs = await k.obs.runners(exec);
          return rs.length > 0 && rs.every((r) => r.status === 'offline') ? true : undefined;
        },
        DEADLINE.event,
        undefined,
        { noIssue: 'it waits on the Runner registrations, which no hold of an Issue changes' },
      );

      // 7: I3's job stays queued, not re-dispatched (R4.23).
      const held = async (when: string) => {
        if (!j3) return;
        const s = await k.obs.fresh();
        const cur = await k.obs.job(exec, j3.id);
        if (startedBefore(cur, stopAt)) return notExercised();
        const later = k
          .stages(s, exec, n3, ['route', 'shape', 'deliver', 'review'])
          .filter((r) => time(r.created_at) > recordedAt);
        c.none(
          'R4.23',
          queuedHoldProblems({ id: j3.id, label, runId: j3.run.id }, cur, later).map((p) => `${when}: ${p}`),
        );
      };
      await held('after the Runners went offline');

      // 8: I4 is dispatched while every Runner is offline (R4.21).
      const n4 = await file(
        'i4',
        'Add isEven',
        changeRequest(k.slug('i4'), 'isEven', 'returns whether its argument is even'),
      );
      const d4 = await k.obs.until(
        "I4's shape job to queue on the Owner's label while the Runners are offline",
        (s) => dispatched(k, s, n4, label),
        DEADLINE.event,
        k.show(exec, n4),
        { ...k.about(exec, n4), gonePast: k.stageGone(exec, n4, 'shape') },
      );
      c.check('R4.21', d4.queued !== undefined, `I4's shape job started while every Runner was offline`);
      const s8 = await k.obs.fresh();
      const strays = (await k.agentJobs(s8, exec, n4)).filter((j) => !j.labels.includes(label));
      c.check(
        'R4.21',
        strays.length === 0,
        `I4 has agent jobs on other labels: ${strays.map((j) => j.labels.join('+')).join(', ')}`,
      );
      await held('after I4 was dispatched');

      // 9–10: wake I with a legal event (R3.43), then bring the Runners back at once.
      await k.addLabels(exec, n, ['pause']);
      await k.removeLabel(exec, n, 'pause');
      await k.ctx.runnerServices('start');
      const names = (await k.gh.list<{ name: string }>(`/repos/${exec}/actions/runners`, 'runners')).map((r) => r.name);

      // 11: the queued jobs run where they were queued.
      for (const [rule, issue, job] of [
        ['R4.23', n3, j3],
        ['R4.21', n4, d4.queued],
      ] as const) {
        if (!job) continue;
        const ran = await k.obs.until(
          `job ${job.id} of #${issue} to start`,
          async () => {
            const j = await k.obs.job(exec, job.id);
            return j.status !== 'queued' && j.runner_name ? j : undefined;
          },
          DEADLINE.stage,
          k.show(exec, issue),
          k.about(exec, issue),
        );
        await k.addLabels(exec, issue, ['pause']);
        c.check(
          rule,
          names.includes(ran.runner_name ?? ''),
          `job ${job.id} ran on ${String(ran.runner_name)}, not on one of this host's Runners (${names.join(', ')})`,
        );
        const shapes = k.stages(await k.obs.fresh(), exec, issue, ['shape']);
        c.check(rule, shapes.length === 1, `#${issue} has ${shapes.length} shape runs, expected the one queued run`);
      }

      const redo = await k.obs.until(
        'a new deliver job of I after the old one completed',
        async (s) => {
          const old = await k.obs.job(exec, oldJob.id);
          const fresh = (await k.agentJobs(s, exec, n, ['deliver'])).filter(
            (j) => j.id !== oldJob.id && j.started_at && j.status !== 'queued',
          );
          return old.status === 'completed' && fresh.length ? { old, fresh } : undefined;
        },
        DEADLINE.stage,
        show,
        { ...k.about(exec, n), gonePast: k.stageGone(exec, n, 'deliver', { jobs: false }) },
      );
      for (const j of redo.fresh) {
        const ok = time(j.started_at) >= time(redo.old.completed_at);
        c.check(
          'R3.44',
          ok,
          `deliver job ${j.id} started at ${String(j.started_at)}, before the interrupted job ${oldJob.id} completed at ${String(redo.old.completed_at)}`,
        );
        c.check('R4.25', ok, `two deliver jobs of I overlapped (${oldJob.id} and ${j.id})`);
        c.check(
          'R3.41',
          j.labels.includes(label),
          `the redone deliver job has labels ${j.labels.join(', ')}, expected ${label}`,
        );
      }

      // 12: review waits for an approval with a comment, not pending (R3.26).
      const pr = await k.obs.until(
        "I's PR",
        (s) => s.pulls.get(exec)?.find((p) => p.head.ref === branch),
        DEADLINE.stage,
        show,
        k.about(exec, n),
      );
      const waits = await k.obs.until(
        'a marked PR comment saying the merge waits for a review',
        async (s) => {
          // Written once a review found the PR mergeable but the approval missing: after a review job started.
          const reviewed = (await k.agentJobs(s, exec, n, ['review']))
            .map((j) => time(j.started_at))
            .filter((t) => !Number.isNaN(t));
          if (!reviewed.length) return undefined;
          const first = Math.min(...reviewed);
          const cm = awaitingReview(await k.obs.comments(exec, pr.number), first);
          return cm ? s : undefined;
        },
        DEADLINE.stage,
        show,
        k.about(exec, n),
      );
      const calm = await k.settle('the review-awaited comment', waits.at, k.runsOf(exec, n));
      c.check(
        'R3.26',
        !k.labels(calm, exec, n).includes('pending'),
        'I got pending while the merge only waited for an approving review',
      );
      c.check(
        'R3.25',
        !calm.pulls.get(exec)?.find((p) => p.number === pr.number)?.merged_at,
        `PR #${pr.number} merged while the approval rule was in force`,
      );

      // 13–14: drop the approval rule, wake, and expect the merge and closure.
      await k.deleteRuleset('e2e-approval');
      const unblockedAt = k.now();
      await k.addLabels(exec, n, ['pause']);
      await k.removeLabel(exec, n, 'pause');
      await k.obs.until('I to close with delivered', (s) => k.delivered(s, exec, n), DEADLINE.delivery, show, {
        ...k.about(exec, n),
        gonePast: k.closeGone(exec, n),
      });
      const prs = await k.obs.pullsByHead(exec, branch);
      const merged = prs.find((p) => p.merged_at);
      c.check('R3.42', prs.length === 1, `${prs.length} PRs use ${branch}, expected one reused PR`);
      if (!merged) {
        c.fail('R3.25', `no merged PR for ${branch}`);
        c.fail('R5.74', `no merged PR for ${branch}, so no finish merge to check`);
      } else {
        c.check(
          'R3.25',
          time(merged.merged_at) > unblockedAt,
          `PR #${merged.number} merged before the approval rule was removed`,
        );
        c.check(
          'R3.41',
          await k.obs.descends(exec, h1, merged.head.sha),
          `the merged head ${merged.head.sha} does not descend from ${h1}, the branch head before the interruption`,
        );
        c.none('R1.13', closingProblems(await k.obs.comments(exec, n), [merged]));
        c.none(
          'R3.42',
          duplicateMarkers(await k.obs.comments(exec, merged.number)).map(
            (d) => `PR #${merged.number} has the marked comment ${d}`,
          ),
        );

        // R5.72, R5.74: with its passing review recorded, the waiting PR is merged by a hosted finish job, with no agent between the wake and the merge.
        const s = await k.obs.fresh();
        const mergedAt = time(merged.merged_at);
        const finish = await k.finishJobs(s, exec, n);
        const afterWake = finish.filter((j) => time(j.run.created_at) >= unblockedAt);
        const merger = finishAt(afterWake, mergedAt, false);
        const wake = new Date(unblockedAt).toISOString();
        c.check(
          'R5.74',
          !!merger,
          `I has no finish job after the wake ${wake} whose window contains the merge ${String(merged.merged_at)}; ${stageSeen(finish)}`,
        );
        if (merger)
          c.check(
            'R5.72',
            githubHosted(merger),
            `the finish job that merged PR #${merged.number} did not run GitHub-hosted: ${describeJob(merger.run, merger)}`,
          );
        else c.fail('R5.72', `no finish job after the wake ${wake} merged PR #${merged.number}; ${stageSeen(finish)}`);
        c.none('R5.72', hostedRunProblems(finish, names));
        const agents = (await k.windows(s, exec, n)).filter((w) => overlap(w, { start: unblockedAt, end: mergedAt }));
        c.check(
          'R5.74',
          agents.length === 0,
          `agent jobs of I ran between the wake ${wake} and the merge ${String(merged.merged_at)}: ${agents.map((w) => `${w.stage} job ${w.jobId} on ${String(w.runner)}`).join(', ')}`,
        );
      }
      const forced = await k.obs.activity(exec, { ref: `refs/heads/${branch}`, type: 'force_push' });
      c.check(
        'R1.12',
        forced.length === 0,
        `${branch} was force-pushed ${forced.length} time(s); the redo did not resume from the branch`,
      );
      c.none(
        'R3.42',
        duplicateMarkers(await k.obs.comments(exec, n)).map((d) => `#${n} has the marked comment ${d}`),
      );
      c.note('R4.23 is exercised for its first clause only; its queue-limit clause needs a 24-hour queue');
      return c.outcome(
        `#${n} resumed from its branch after the Runners stopped mid-Deliver and was delivered; #${n3}'s queued job waited for the Runners; #${n4} queued while they were offline`,
      );
    } finally {
      await k.ctx
        .runnerServices('start')
        .catch((e: unknown) => k.ctx.log(`starting the Runner services failed: ${message(e)}`));
      await k
        .deleteRuleset('e2e-approval')
        .catch((e: unknown) => k.ctx.log(`deleting e2e-approval failed: ${message(e)}`));
      await k.pauseOpen(exec, filed);
    }
  },
});
