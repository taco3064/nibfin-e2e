// Phase 1: scenarios that change the whole host (the login, the Runner services), so
// each runs alone.
import type { Scenario } from '../../src/types.ts';
import {
  AGENT_STAGES,
  Checks,
  busyTogether,
  describeJob,
  duplicateMarkers,
  githubHosted,
  issueKey,
  jobWindow,
  markerOf,
  overlap,
  queuedHoldProblems,
  ranOnRunner,
  selfHosted,
  startedBefore,
  time,
} from './analysis.ts';
import type { Comment, Issue, Job, Run, Stage } from './analysis.ts';
import { DEADLINE, changeRequest, finishAt, hostedRunProblems, stageSeen, lifecycle, message, redact } from './kit.ts';
import type { Kit } from './kit.ts';
import { AWAITS_REVIEW, RELOGIN, SHAPE_MARKER } from './marks.ts';
import type { Snapshot } from './observe.ts';

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
        { gonePast: exit },
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
        { gonePast: exit },
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
 * Why I's deliver job and I2's shape job can no longer hold both Runners at once: they
 * cannot cover the registered Runners, ran on the same one, I's job completed before
 * I2's started, or I2's job completed before I's started. `oldJob` is `undefined` while
 * I's deliver job has not started. Read from the jobs' own times, not from a snapshot's
 * Runner list.
 */
export function busyGone(oldJob: Job | undefined, shapeJob: Job | undefined, runners: string[]): string | undefined {
  if (runners.length !== 2) return `the registered Runners are ${runners.join(', ') || 'none'}; I's deliver job and I2's shape job cannot cover them`;
  const shapeStarted = shapeJob !== undefined && jobWindow(shapeJob, 'I2', 'shape') !== undefined;
  if (oldJob) {
    if (shapeStarted && shapeJob.runner_name === oldJob.runner_name) return `I2's shape job ${shapeJob.id} ran on ${String(shapeJob.runner_name)}, the same Runner as I's deliver job ${oldJob.id}`;
    if (oldJob.status === 'completed' && (!shapeStarted || time(shapeJob.started_at) >= time(oldJob.completed_at))) {
      return `I's deliver job ${oldJob.id} completed at ${String(oldJob.completed_at)} before I2's shape job started`;
    }
  }
  if (shapeStarted && shapeJob.status === 'completed' && (!oldJob || time(shapeJob.completed_at) <= time(oldJob.started_at))) {
    return oldJob
      ? `I2's shape job ${shapeJob.id} completed at ${String(shapeJob.completed_at)} before I's deliver job ${oldJob.id} started at ${String(oldJob.started_at)}`
      : `I2's shape job ${shapeJob.id} completed at ${String(shapeJob.completed_at)} before I's deliver job started`;
  }
  return undefined;
}

/** When I2 is filed: once I is `shaped` or has a deliver run, so that I2's route and shape can overlap I's Deliver. */
export function i2Due(labels: readonly string[], stages: readonly Stage[]): boolean {
  return labels.includes('shaped') || stages.includes('deliver');
}

/** Whether every registered Runner was busy with one of the jobs at `t`, from the jobs' own windows. */
export function allBusyAt(t: number, jobs: Job[], runners: string[]): boolean {
  const windows = jobs.flatMap((j) => jobWindow(j, '', 'shape') ?? []);
  return (
    runners.length > 0 && runners.every((name) => windows.some((w) => w.runner === name && w.start <= t && t <= w.end))
  );
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
      // Every deliver job of I is created after I was filed, so none is skipped however late a wait builds this check.
      const iGone = k.stageGone(exec, n, 'deliver', { since: iFiledAt - 60_000 });

      // I2 is filed once I is shaped or its deliver run exists, so that I2's route and shape can overlap I's Deliver.
      await k.obs.until(
        'I to be shaped or its deliver run to exist',
        (s) => (i2Due(k.labels(s, exec, n), k.stages(s, exec, n, ['deliver']).map((r) => r.stage)) ? true : undefined),
        DEADLINE.stage,
        show,
        { gonePast: k.stageGone(exec, n, 'shape') },
      );
      const n2 = await file('i2', 'Add decrement', changeRequest(k.slug('i2'), 'decrement', 'returns its argument minus one'));

      // 4: I2 takes the second Runner while I's deliver job holds the other: both Runners busy, read from the jobs' own times.
      const runnerNames = (await k.obs.runners(exec)).map((r) => r.name);
      const i2Shape = async (s: Snapshot) => (await k.agentJobs(s, exec, n2, ['shape'])).find((j) => jobWindow(j, issueKey(exec, n2), 'shape'));
      const iDeliver = async (s: Snapshot) => {
        const j = (await k.agentJobs(s, exec, n, ['deliver'])).find((x) => jobWindow(x, issueKey(exec, n), 'deliver'));
        return j && k.obs.job(exec, j.id);
      };
      const i2Gone = k.stageGone(exec, n2, 'shape');
      await k.obs.until(
        'I2\'s shape job to run while I\'s deliver job holds the other Runner',
        async (s) => {
          const j = await i2Shape(s);
          const d = await iDeliver(s);
          const old = d && jobWindow(d, issueKey(exec, n), 'deliver');
          const w = j && jobWindow(j, issueKey(exec, n2), 'shape');
          return old && w && busyTogether([old, w], runnerNames) ? { deliver: d, shape2: j } : undefined;
        },
        DEADLINE.stage,
        k.show(exec, n, n2),
        { gonePast: async (s) => busyGone(await iDeliver(s), await i2Shape(s), runnerNames) ?? (await i2Gone(s)) ?? iGone(s) },
      );

      // I3 is filed as soon as the overlap is seen, so that its route starts while both Runners are busy.
      const n3 = await file('i3', 'Add sign', changeRequest(k.slug('i3'), 'sign', 'returns -1, 0 or 1 for the sign of its argument'));

      // 3: I's Deliver runs and has pushed to its branch. It runs after step 4: I2 was filed when I got shaped or its deliver run appeared.
      const { oldJob, h1 } = await k.obs.until(
        "I's deliver job to run with commits on its branch",
        async (s) => {
          const j = (await k.agentJobs(s, exec, n, ['deliver'])).find((x) => x.status === 'in_progress');
          if (!j) return undefined;
          const cmp = await k.gh.rest<{ ahead_by: number }>(
            'GET',
            `/repos/${exec}/compare/main...${branch}`,
            undefined,
            [404],
          );
          if (cmp.status === 404 || cmp.data.ahead_by < 1) return undefined;
          const { data } = await k.gh.rest<{ commit: { sha: string } }>('GET', `/repos/${exec}/branches/${branch}`);
          return { oldJob: j, h1: data.commit.sha };
        },
        DEADLINE.stage,
        show,
        { gonePast: iGone },
      );

      // 5: I3 is dispatched while the member is online; its job queues (R4.23). I2 may be in Shape or already in Deliver.
      const d3 = await k.obs.until(
        'I3\'s shape job to queue on the Owner\'s label while I\'s deliver job and I2\'s shape or deliver job hold both Runners',
        async (s) => {
          const d = await dispatched(k, s, n3, label);
          if (!d) return undefined;
          if (d.started) return d;
          // The windows are re-read until those jobs complete.
          return allBusyAt(s.at, [await k.obs.job(exec, oldJob.id), ...(await k.agentJobs(s, exec, n2))], runnerNames) ? d : undefined;
        },
        DEADLINE.event,
        k.show(exec, n3),
        { gonePast: k.stageGone(exec, n3, 'shape') },
      );
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
      await k.ctx.stopJobContainers(exec, n2);
      await k.addLabels(exec, n2, ['pause']);
      await k.obs.until(
        'both Runner registrations to read offline',
        async () => {
          const rs = await k.obs.runners(exec);
          return rs.length > 0 && rs.every((r) => r.status === 'offline') ? true : undefined;
        },
        DEADLINE.event,
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
        {
          gonePast: k.stageGone(exec, n4, 'shape'),
        },
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
        { gonePast: k.stageGone(exec, n, 'deliver', { jobs: false }) },
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
