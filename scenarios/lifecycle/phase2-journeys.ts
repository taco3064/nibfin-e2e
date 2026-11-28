// Phase 2 scenarios that assert on the shared journeys (A, X, B, C, U and P).
import type { Scenario } from '../../src/types.ts';
import {
  AGENT_STAGES,
  BRANCH_WRITES,
  Checks,
  issueKey,
  parseStageTitle,
  concurrentPair,
  describeComments,
  describeJob,
  githubHosted,
  jobWindow,
  windowAt,
  firstMark,
  isIssueBranch,
  markWindow,
  markerOf,
  noPublishingJobMessage,
  noVerdictMessage,
  publishingJob,
  pushWakeSha,
  pushesWithin,
  ranOnRunner,
  refersToIssue,
  routePodmanProblems,
  rereadWindows,
  sameIssueOverlapMessage,
  sameIssueOverlaps,
  STAGES,
  time,
} from './analysis.ts';
import type { Activity, Job, ReadWindow, Run, Window } from './analysis.ts';
import { holdJourney, journey } from './journeys.ts';
import { DEADLINE, finishAt, hostedRunProblems, message, stageSeen, lifecycle } from './kit.ts';
import type { Kit } from './kit.ts';
import {
  ACCEPT_END,
  ACCEPT_START,
  BLOCKER_REPORT,
  NO_ASSIGNEE_REPORT,
  SHAPE_MARKER,
  VALIDATOR_VERDICT,
} from './marks.ts';
import type { Snapshot } from './observe.ts';
import { IMAGE } from '../lib/observed-facts.ts';
import { closingProblems } from './phase1.ts';

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * R3.13 / R3.40: the log of the shape job that published the Shape shows a Validator
 * verdict before the Shape comment and `shaped`. A first Shape is published when the
 * comment is created; a rewrite (`rewrite`) when the existing comment is updated. The
 * judged job is the one whose window holds that time, never a later shape job.
 */
async function validatorProblems(
  k: Kit,
  s: Snapshot,
  repo: string,
  n: number,
  after: number,
  rewrite = false,
): Promise<string[]> {
  const comment = (await k.obs.comments(repo, n)).find((x) => SHAPE_MARKER.test(markerOf(x.body) ?? ''));
  if (!comment) return [`#${n} has no marked Shape comment`];
  const published = time(rewrite ? comment.updated_at : comment.created_at);
  const shapedAt = await k.labeledAt(repo, n, 'shaped', after);
  const jobs = (await k.agentJobs(s, repo, n, ['shape'])).filter(
    (j) => j.status === 'completed' && j.conclusion === 'success' && time(j.started_at) >= after,
  );
  const job = publishingJob(jobs, issueKey(repo, n), published);
  if (!job) return [noPublishingJobMessage({ n, rewrite, after, published, jobs })];
  const lines = await k.obs.log(k.exec, job.id);
  const verdict = firstMark(lines, VALIDATOR_VERDICT);
  if (!verdict) return [noVerdictMessage({ job: job.id, n, rewrite, published, lines })];
  if (verdict.at === undefined) return [`the Validator verdict line of job ${job.id} has no timestamp`];
  const out: string[] = [];
  if (verdict.at > published)
    out.push(
      `the Validator verdict (${iso(verdict.at)}) comes after the Shape comment was written (${iso(published)})`,
    );
  if (shapedAt !== undefined && verdict.at > shapedAt)
    out.push(`the Validator verdict (${iso(verdict.at)}) comes after \`shaped\` (${iso(shapedAt)})`);
  return out;
}

export const deliveryLifecycle: Scenario = lifecycle({
  id: 'delivery-lifecycle',
  concurrent: true,
  rules: [
    'R1.11',
    'R3.13',
    'R3.15',
    'R3.16',
    'R3.17',
    'R3.19',
    'R3.22',
    'R3.23',
    'R3.24',
    'R3.25',
    'R3.31',
    'R3.33',
    'R3.34',
    'R3.35',
    'R3.36',
    'R4.7',
    'R4.9',
    'R4.10',
    'R4.18',
    'R4.34',
    'R4.35',
    'R5.7',
    'R5.70',
    'R5.72',
    'R5.74',
    'R6.5',
  ],
  async run(k) {
    const j = await journey(k);
    const c = new Checks();
    const { exec } = k;
    const n = j.a.number;
    const branch = `nibfin/issue-${n}`;
    const owner = await k.owner();
    const label = await k.ownerLabel();

    c.check(
      'R4.7',
      j.aBeforeScope.stageRuns === 0 && j.aBeforeScope.comments === 0,
      `before \`scope\`, A had ${j.aBeforeScope.stageRuns} stage runs and ${j.aBeforeScope.comments} comments`,
    );
    const s = await k.obs.fresh();
    c.none('R3.13', await validatorProblems(k, s, exec, n, j.aScopedAt));

    // R4.9, R4.10: Shape before Deliver, Deliver only once `shaped`.
    const firstDeliver = k.stages(s, exec, n, ['deliver'])[0];
    const shapedAt = await k.labeledAt(exec, n, 'shaped');
    c.check('R4.9', k.stages(s, exec, n, ['shape']).length > 0, 'A was never shaped');
    c.check(
      'R4.10',
      !!firstDeliver && shapedAt !== undefined && time(firstDeliver.created_at) >= shapedAt,
      `A's first deliver run (${String(firstDeliver?.created_at)}) is not after \`shaped\``,
    );

    // R3.15, R6.5: only the Writer writes the branch; the Validator and the Acceptor never push.
    const windows = await k.windows(s, exec, n, true);
    // Every write to a branch derived from A, so a push to another of A's branches is seen too.
    const allOfA = (await k.obs.activity(exec)).filter(
      (a) => isIssueBranch(a.ref, n) && BRANCH_WRITES.has(a.activity_type),
    );
    const elsewhere = allOfA.filter((a) => a.ref !== `refs/heads/${branch}`);
    c.check(
      'R3.16',
      elsewhere.length === 0,
      `A's work was pushed to ${[...new Set(elsewhere.map((a) => a.ref))].join(', ')}, not only ${branch}`,
    );
    const acts = allOfA.filter((a) => a.ref === `refs/heads/${branch}`);
    const inside = (a: Activity, w: Window) => time(a.timestamp) >= w.start && time(a.timestamp) <= w.end;
    c.check('R3.15', acts.length > 0, `no push to ${branch} is recorded in the repository activity`);
    for (const a of acts) {
      const ws = windows.filter((w) => inside(a, w));
      c.check(
        'R3.15',
        ws.some((w) => w.stage === 'deliver'),
        `the ${a.activity_type} at ${a.timestamp} to ${branch} is outside every deliver job of A`,
      );
      const other = ws.find((w) => w.stage === 'shape' || w.stage === 'review');
      c.check(
        'R6.5',
        !other,
        `the ${a.activity_type} at ${a.timestamp} falls inside A's ${other?.stage} job ${other?.jobId}`,
      );
    }
    const pr = (await k.obs.pullsByHead(exec, branch)).find((p) => p.merged_at) ?? j.aPr;
    const deliverJobs = (await k.agentJobs(s, exec, n, ['deliver'])).filter((x) => x.status === 'completed');
    let acceptBeforePr = false;
    for (const dj of deliverJobs) {
      const w = markWindow(await k.obs.log(exec, dj.id), ACCEPT_START, ACCEPT_END);
      if (!w) {
        c.fail('R6.5', `deliver job ${dj.id} shows no timestamped Accept marks`);
        continue;
      }
      const pushed = pushesWithin(acts, w);
      c.check(
        'R6.5',
        pushed.length === 0,
        `${pushed.length} push(es) to ${branch} during the Accept check of job ${dj.id}`,
      );
      if (w.end <= time(pr.created_at) && time(dj.started_at) <= time(pr.created_at)) acceptBeforePr = true;
    }
    c.check('R3.19', acceptBeforePr, `no Accept check ended before PR #${pr.number} was created at ${pr.created_at}`);
    const prs = await k.obs.pullsByHead(exec, branch);
    c.check(
      'R3.16',
      prs.length === 1 && pr.head.ref === branch,
      `${prs.length} PRs use ${branch}; A's PR head is ${pr.head.ref}`,
    );

    // R4.35: the two wakes during Deliver started no stage again.
    const wakes = j.wakeToggles;
    if ('missed' in wakes) c.notExercised('R4.35', `no wakes were sent during A's Deliver: ${wakes.missed}`);
    else {
      const toggled = await k.obs.job(exec, wakes.jobId);
      const from = wakes.at[0] ?? 0;
      const to = toggled.completed_at ? time(toggled.completed_at) : k.now();
      if (to <= (wakes.at.at(-1) ?? 0))
        c.notExercised(
          'R4.35',
          `deliver job ${toggled.id} completed at ${String(toggled.completed_at)}, before the wakes ended`,
        );
      else {
        const again = k
          .stages(s, exec, n, AGENT_STAGES)
          .filter((r) => time(r.created_at) >= from && time(r.created_at) <= to);
        c.check(
          'R4.35',
          again.length === 0,
          `while Deliver ran, the wakes started ${again.map((r) => r.stage).join(', ')}`,
        );
      }
    }

    // R3.22–R3.25, R3.33: review after the required `test` completed on the reviewed head, and that head merged.
    const head = pr.head.sha;
    const test = (await k.obs.checkRuns(exec, head)).find((x) => x.name === 'test');
    c.check(
      'R3.33',
      test?.status === 'completed' && test.conclusion === 'success',
      `the required check test on ${head} is ${String(test?.status)}/${String(test?.conclusion)}`,
    );
    const reviews = (await k.agentJobs(s, exec, n, ['review'])).filter((x) => time(x.started_at) < time(pr.merged_at));
    const lastReview = reviews.at(-1);
    if (!lastReview) c.fail('R3.23', 'no review job ran before the merge');
    else {
      c.check(
        'R3.22',
        test?.completed_at !== null && time(lastReview.started_at) >= time(test?.completed_at),
        `review job ${lastReview.id} started before test completed on ${head}`,
      );
      c.check(
        'R3.23',
        time(lastReview.started_at) >= time(test?.completed_at),
        'the review was not dispatched after PR CI completed',
      );
      const late = acts.filter(
        (a) => time(a.timestamp) > time(lastReview.started_at) && time(a.timestamp) < time(pr.merged_at),
      );
      c.check(
        'R3.25',
        late.length === 0,
        `${branch} changed after the last review started and before the merge (${late.map((a) => a.after.slice(0, 7)).join(', ')})`,
      );
      c.check('R3.24', !!pr.merged_at, 'the reviewed PR was not merged');
    }

    // R3.31, R3.34–R3.36: CD is the merge's push runs; closure waits for all of them.
    c.check(
      'R3.35',
      s.runs.some((r) => r.repo === exec && j.mergeSha.startsWith(pushWakeSha(r.display_title) ?? '-')),
      `no \`@${j.mergeSha.slice(0, 7)} · wake\` run in ${exec}`,
    );
    c.check('R3.34', j.openWhileCdHeld, 'A closed while CD of its merge was still running');
    c.check('R3.36', j.openAfterCd, 'A closed while a new CI run attempt of its merge was still running');
    const a = k.issue(s, exec, n);
    c.check(
      'R3.31',
      a?.state === 'closed' && a.state_reason === 'completed' && k.labels(s, exec, n).includes('delivered'),
      `A is ${String(a?.state)}/${String(a?.state_reason)} [${k.labels(s, exec, n).join(', ')}]`,
    );
    c.none('R3.31', closingProblems(await k.obs.comments(exec, n), [pr]));

    // R3.17: branches are deleted only once the Issue is closed, never at the merge.
    const closedAt = time(a?.closed_at);
    const deletions = await k.obs.until(
      `the deletion of ${branch}`,
      async () => {
        const d = (await k.obs.activity(exec, { type: 'branch_deletion' })).filter((x) => isIssueBranch(x.ref, n));
        return d.length ? d : undefined;
      },
      DEADLINE.event,
    );
    for (const d of deletions)
      c.check(
        'R3.17',
        time(d.timestamp) >= closedAt,
        `${d.ref} was deleted at ${d.timestamp}, before A closed at ${String(a?.closed_at)}`,
      );

    // R4.34, R4.18: Nibfin writes as the init credential's login and routes by Assignee.
    c.check(
      'R4.34',
      pr.user?.login === owner.login,
      `PR #${pr.number} was opened by ${String(pr.user?.login)}, not ${owner.login}`,
    );
    for (const cm of (await k.obs.comments(exec, n)).filter((x) => markerOf(x.body))) {
      c.check('R4.34', cm.user?.login === owner.login, `marked comment ${cm.html_url} is by ${String(cm.user?.login)}`);
    }
    const agentJobs = await k.agentJobs(s, exec, n);
    const strays = agentJobs.filter((x) => !x.labels.includes(label));
    c.check('R4.18', agentJobs.length > 0, 'A has no agent jobs');
    c.check(
      'R4.18',
      strays.length === 0,
      `A's agent jobs ran on ${strays.map((x) => x.labels.join('+')).join(', ')}, not ${label}`,
    );

    // R5.7: the agent jobs ran on the sandbox's own Runners with the Owner's label.
    const sandboxRunners = (await k.obs.runners(exec)).map((r) => r.name);
    const offHost = agentJobs.filter(
      (x) => x.runner_name && (!sandboxRunners.includes(x.runner_name) || !x.labels.includes(label)),
    );
    c.check(
      'R5.7',
      agentJobs.length > 0 && offHost.length === 0,
      `A's agent jobs ran outside the sandbox's Runners (${sandboxRunners.join(', ')}) with ${label}: ${offHost.map((x) => describeJob(x.run, x)).join('; ') || 'A has no agent jobs'}`,
    );

    // R5.70, R5.7: on the public sandbox A's route jobs ran GitHub-hosted, on none of its Runners,
    // and ran the image under Podman. Route runs no runner took (cancelled or skipped) are ignored.
    const route = await k.windowedJobs(s, exec, n, ['route']);
    const ran = route.filter((x) => x.window);
    c.check(
      'R5.70',
      ran.length > 0,
      `A has no route job a runner took; ${route.length ? stageSeen(route, 'route') : 'A had no route run'}`,
    );
    const routeProblems = hostedRunProblems(route, sandboxRunners);
    c.none('R5.70', routeProblems);
    c.none('R5.7', routeProblems);
    // A job log is complete only once the job is; a route job still running is judged by placement alone.
    const done = ran.filter((x) => x.status === 'completed');
    c.check(
      'R5.70',
      ran.length === 0 || done.length > 0,
      `none of A's route jobs a runner took has completed, so no log shows the image under Podman; ${stageSeen(ran, 'route')}`,
    );
    for (const x of done) c.none('R5.70', routePodmanProblems(x.run, x, await k.obs.log(exec, x.id), IMAGE));

    // R5.72, R5.74: no finish job of A ran on a self-hosted or sandbox Runner (so none started an agent).
    const finish = await k.finishJobs(s, exec, n);
    const finishProblems = hostedRunProblems(finish, sandboxRunners);
    c.none('R5.72', finishProblems);
    c.none(
      'R5.74',
      finishProblems.map((p) => `the finish Job runs no agent, but ${p}`),
    );

    // R5.74 closing clause: the close, `delivered` and the closing comment happen inside a hosted finish job.
    const closer = finishAt(finish, closedAt);
    c.check(
      'R5.74',
      !!closer,
      `A has no hosted finish job whose window contains its close ${String(a?.closed_at)}; ${stageSeen(finish)}`,
    );
    const anyCloser = finishAt(finish, closedAt, false);
    for (const rule of ['R5.72', 'R5.7'] as const) {
      c.check(
        rule,
        !!anyCloser && githubHosted(anyCloser),
        anyCloser
          ? `the finish job that closed A did not run GitHub-hosted: ${describeJob(anyCloser.run, anyCloser)}`
          : `no finish job's window contains A's close ${String(a?.closed_at)}; ${stageSeen(finish)}`,
      );
    }
    const deliveredAt = await k.labeledAt(exec, n, 'delivered');
    c.check(
      'R5.74',
      deliveredAt !== undefined && !!finishAt(finish, deliveredAt),
      `\`delivered\` was added to A at ${deliveredAt === undefined ? 'no time seen' : iso(deliveredAt)}, outside every hosted finish job; ${stageSeen(finish)}`,
    );
    const closing = (await k.obs.comments(exec, n)).filter((x) => markerOf(x.body)).at(-1);
    if (!closing) c.fail('R5.74', 'A has no marked closing comment');
    else {
      for (const at of new Set([closing.created_at, closing.updated_at])) {
        c.check(
          'R5.74',
          !!finishAt(finish, time(at)),
          `the closing comment ${closing.html_url} was written at ${at}, outside every hosted finish job; ${stageSeen(finish)}`,
        );
      }
    }

    // R5.74 (a head that still needs review goes to Review), R3.24: the clean review on the Owner's Runner merged it.
    if (lastReview) {
      c.check(
        'R5.74',
        lastReview.labels.includes(label) && sandboxRunners.includes(lastReview.runner_name ?? ''),
        `the review before the merge did not run on the Owner's Runner with ${label}: ${describeJob(lastReview.run, lastReview)}`,
      );
      const w = jobWindow(lastReview, issueKey(exec, n), 'review');
      const mergedIn = !!w && !!windowAt(time(pr.merged_at), [w]);
      const why = `PR #${pr.number} merged at ${String(pr.merged_at)}, outside the review job ${describeJob(lastReview.run, lastReview)} (${lastReview.started_at ?? '?'}–${lastReview.completed_at ?? 'running'})`;
      c.check('R3.24', mergedIn, why);
      c.check('R5.74', mergedIn, why);
    }
    // Every finish run of A, those before the merge included, is held to hosted-only above, so no agent reviewed A in finish.
    c.note(
      "delivery-lifecycle does not drive R5.74's changes-request clause or its wake-redo-after-delivered-close clause",
    );
    return c.outcome(
      `#${n} went Shape → Deliver → PR CI → review → merge → CD → delivered (PR #${pr.number}, ${j.mergeSha.slice(0, 7)})`,
    );
  },
});

export const deliveryParallel: Scenario = lifecycle({
  id: 'delivery-parallel',
  concurrent: true,
  rules: ['R4.17', 'R4.25', 'R4.36', 'R6.5'],
  async run(k) {
    const j = await journey(k);
    const c = new Checks();
    const { exec } = k;
    const s = await k.obs.fresh();
    // Every Issue with stage runs in the journey's window, in either sandbox: phase 2 shares the host's Runners.
    const issues = new Map<string, { repo: string; n: number }>();
    for (const r of s.runs) {
      const t = parseStageTitle(r.display_title);
      if (r.repo === exec && t && time(r.created_at) >= j.startedAt && time(r.created_at) <= j.endedAt)
        issues.set(issueKey(t.repo, t.issue), { repo: t.repo, n: t.issue });
    }
    const agent: Window[] = [];
    // Every job of every stage run; one its run job list showed unfinished is read again by id.
    const all: ReadWindow[] = [];
    for (const { repo, n } of issues.values()) {
      agent.push(...(await k.windows(s, repo, n)));
      const jobs = await k.stageJobs(s, repo, n, STAGES);
      all.push(...(await rereadWindows(jobs, issueKey(repo, n), (id) => k.obs.job(exec, id), () => k.now())));
    }
    const inJourney = (w: Window) => w.start >= j.startedAt && w.start <= j.endedAt;
    const pair = concurrentPair(agent.filter(inJourney));
    c.check('R6.5', pair !== undefined, 'no two agent jobs of different Issues ran at the same time on two Runners');
    const writers = sameIssueOverlaps(agent.filter((w) => w.stage === 'deliver'));
    c.check('R6.5', writers.length === 0, `two Writers overlapped on ${writers.map(([a]) => a.issue).join(', ')}`);
    for (const [a, b] of sameIssueOverlaps(all)) {
      const what = sameIssueOverlapMessage(a, b);
      c.fail('R4.25', what);
      c.fail('R4.36', what);
    }
    // R4.17: X asked for codex in its text and NIBFIN_PROVIDER=codex is set; it ran on this host's Claude Runners.
    const names = (await k.obs.runners(exec)).map((r) => r.name);
    const xJobs = await k.agentJobs(s, exec, j.x.number);
    c.check(
      'R4.17',
      k.delivered(s, exec, j.x.number) !== undefined,
      `X is not delivered: ${await k.summary(s, exec, j.x.number, { full: true })}`,
    );
    const foreign = xJobs.filter((x) => !names.includes(x.runner_name ?? ''));
    c.check(
      'R4.17',
      xJobs.length > 0 && foreign.length === 0,
      `X's agent jobs ran on ${foreign.map((x) => String(x.runner_name)).join(', ') || 'nothing'}, not only this host's Claude Runners (${names.join(', ')})`,
    );
    return c.outcome(
      pair
        ? `${pair[0].issue} and ${pair[1].issue} ran at once on ${pair[0].runner} and ${pair[1].runner}; no Issue ever had two jobs at once`
        : 'parallel',
    );
  },
});

/** What the route of an Issue reported: whether a readable job log or marked comment matched, and the route job logs that could not be read. */
export interface RouteReport {
  reported: boolean;
  unreadable: string[];
}

/**
 * Whether the route of an Issue reported something, in its job log or a marked comment.
 * A route job no runner took is not read; a log that cannot be read gives no evidence and
 * is named in `unreadable`, so a missing report can be told apart from an unreadable log.
 */
export async function routeReport(
  k: Kit,
  s: Snapshot,
  n: number,
  pattern: RegExp,
  before = Infinity,
): Promise<RouteReport> {
  const unreadable: string[] = [];
  for (const job of routeJobs(await k.stageJobs(s, k.exec, n, ['route']), before).read) {
    const lines = await k.obs.log(k.exec, job.id).catch((e: unknown) => {
      unreadable.push(`route job ${job.id} (run ${job.run.id}): ${message(e)}`);
      return [];
    });
    if (lines.some((l) => pattern.test(l.text))) return { reported: true, unreadable };
  }
  // Only comments written by then: a later Shape or closing comment may name the dependency too.
  const reported = (await k.obs.comments(k.exec, n)).some(
    (x) => markerOf(x.body) && pattern.test(x.body ?? '') && time(x.created_at) <= before,
  );
  return { reported, unreadable };
}

/** A failure message for a route report, naming the route job logs that could not be read. */
export const reportFailure = (why: string, r: RouteReport, evidence?: string) => {
  const base = r.unreadable.length ? `${why}; route job logs unreadable: ${r.unreadable.join('; ')}` : why;
  return evidence === undefined ? base : `${base}; ${evidence}`;
};

type RouteJob = Job & { run: Run };

/**
 * The route jobs `routeReport` reads (completed, ran on a runner, completed by `before`)
 * and the ones it skips, each with the reason it was skipped.
 */
export function routeJobs<J extends RouteJob>(
  jobs: J[],
  before = Infinity,
): { read: J[]; skipped: { job: J; reason: string }[] } {
  const read: J[] = [];
  const skipped: { job: J; reason: string }[] = [];
  for (const job of jobs) {
    if (job.status !== 'completed') skipped.push({ job, reason: 'not completed' });
    else if (!ranOnRunner(job)) skipped.push({ job, reason: 'not run on a runner' });
    else if (time(job.completed_at) > before)
      skipped.push({ job, reason: `completed after the cutoff ${new Date(before).toISOString()}` });
    else read.push(job);
  }
  return { read, skipped };
}

/** Bounds of the route evidence in a failure message: per quoted line, lines per log, comments, and in total. */
export const EVIDENCE_LINE = 160;
export const EVIDENCE_LINES = 5;
export const EVIDENCE_COMMENTS = 3;
export const EVIDENCE_TOTAL = 1500;

const cut = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

/**
 * What the route of Issue `n` showed up to `before`, for an R3.32 failure (Proposal R1.14):
 * the route jobs read, with a bounded excerpt of each log (its lines naming the Issue, or
 * else its last lines, without runner directives), the route jobs skipped and why, and the
 * Nibfin-marked comments by the cutoff. Logs are GitHub's masked text; reasons are redacted
 * by `lifecycle()`. Only called on the failure path; the Observer memoizes the reads.
 */
export async function routeEvidence(k: Kit, s: Snapshot, n: number, before = Infinity): Promise<string> {
  const { read, skipped } = routeJobs(await k.stageJobs(s, k.exec, n, ['route']), before);
  const reads: string[] = [];
  for (const job of read) {
    const head = `job ${job.id} (run ${job.run.id}, ${String(job.conclusion)}, completed ${String(job.completed_at)})`;
    const lines = await k.obs.log(k.exec, job.id).catch(() => undefined);
    if (!lines) {
      reads.push(`${head} log unreadable`);
      continue;
    }
    const kept = lines.map((l) => l.text.trim()).filter((t) => t && !t.startsWith('##['));
    const naming = kept.filter((t) => refersToIssue(t, k.exec, n));
    const [label, picked] = naming.length
      ? [`lines naming #${n}`, naming.slice(0, EVIDENCE_LINES)]
      : ['last lines', kept.slice(-EVIDENCE_LINES)];
    reads.push(
      picked.length
        ? `${head} ${label}: ${picked.map((t) => `\`${cut(t, EVIDENCE_LINE)}\``).join('; ')}`
        : `${head} log empty`,
    );
  }
  const cutoff = Number.isFinite(before) ? ` by ${new Date(before).toISOString()}` : '';
  const marked = (await k.obs.comments(k.exec, n)).filter((x) => markerOf(x.body) && time(x.created_at) <= before);
  const comments = marked.length
    ? `marked comments${cutoff}: ${describeComments(marked.slice(0, EVIDENCE_COMMENTS))}${marked.length > EVIDENCE_COMMENTS ? ` (of ${marked.length})` : ''}`
    : `no marked comment${cutoff}`;
  const out = [
    `route jobs read: ${reads.join('; ') || 'none'}`,
    `route jobs skipped: ${skipped.map(({ job, reason }) => `job ${job.id} (run ${job.run.id}): ${reason}`).join('; ') || 'none'}`,
    comments,
  ].join('; ');
  return cut(out, EVIDENCE_TOTAL);
}

export const blockedByChain: Scenario = lifecycle({
  id: 'delivery-blocked-by-chain',
  concurrent: true,
  rules: ['R3.31', 'R3.32', 'R4.11', 'R4.28', 'R4.29', 'R4.30', 'R5.74'],
  async run(k) {
    const j = await journey(k);
    const c = new Checks();
    const { exec } = k;
    const s = await k.obs.fresh();
    const closed = (n: number) => time(k.issue(s, exec, n)?.closed_at);
    const firstAgent = (n: number) => k.stages(s, exec, n, AGENT_STAGES)[0];

    // R4.28: only native Blocked by counts; X's "Blocked by #C" text does not hold it back.
    const x0 = firstAgent(j.x.number);
    c.check(
      'R4.28',
      !!x0 && time(x0.created_at) < closed(j.c.number),
      `X's first agent stage run (${String(x0?.created_at)}) waited for C, which X only names in text`,
    );

    for (const [name, n, up, upName, lastWrite] of [
      ['B', j.b.number, j.a.number, 'A', j.lastWrite.b],
      ['C', j.c.number, j.b.number, 'B', j.lastWrite.c],
    ] as const) {
      const upClosed = closed(up);
      const early = k.stages(s, exec, n, AGENT_STAGES).filter((r) => time(r.created_at) < upClosed);
      c.check(
        'R4.29',
        early.length === 0,
        `${name} started ${early.map((r) => r.stage).join(', ')} before ${upName} closed`,
      );
      const routed = k
        .stages(s, exec, n, ['route'])
        .some((r) => r.status === 'completed' && time(r.updated_at) < upClosed);
      c.check('R3.32', routed, `${name} had no completed route run while ${upName} was open`);
      const blocker = await routeReport(k, s, n, BLOCKER_REPORT, upClosed);
      c.check(
        'R3.32',
        blocker.reported,
        reportFailure(
          `${name}'s route did not report its open blocker`,
          blocker,
          blocker.reported ? undefined : await routeEvidence(k, s, n, upClosed),
        ),
      );
      const start = firstAgent(n);
      c.check(
        'R4.29',
        !!start && time(start.created_at) >= upClosed,
        `${name}'s first agent stage run (${String(start?.created_at)}) is not after ${upName} closed`,
      );
      c.check(
        'R4.30',
        lastWrite < upClosed && !!start,
        `${name} was not woken without a harness write after ${upName} closed`,
      );
      c.check('R3.31', !!k.delivered(s, exec, up) && !!start, `${upName}'s closure did not lead to ${name}`);

      // R5.74: the upstream's delivered close came from a hosted finish job, and the downstream woke after it.
      const upFinish = await k.finishJobs(s, exec, up);
      const closer = finishAt(upFinish, upClosed);
      c.check(
        'R5.74',
        !!closer,
        `${upName} (#${up}) has no hosted finish job whose window contains its close ${String(k.issue(s, exec, up)?.closed_at)}; ${stageSeen(upFinish)}`,
      );
      const woken = k.stages(s, exec, n).filter((r) => time(r.created_at) >= upClosed);
      const seen =
        k
          .stages(s, exec, n)
          .map((r) => `${r.display_title} (${r.id}) ${r.stage} ${r.created_at}`)
          .join(', ') || 'none';
      const by = closer
        ? `${closer.run.display_title} (run ${closer.run.id}) job ${closer.name} (${closer.id})`
        : 'no hosted finish job';
      c.check(
        'R5.74',
        woken.length > 0,
        `${name} has no stage run created at or after ${upName}'s close ${String(k.issue(s, exec, up)?.closed_at)} by ${by}; ${name}'s stage runs: ${seen}`,
      );
    }
    c.note('R5.74 downstream wake: only its timing is observable, not that the finish Job itself sent it');

    // R3.32: no Assignee is reported, with no stage.
    const u = j.u.number;
    c.check(
      'R3.32',
      k.stages(s, exec, u, ['route']).some((r) => r.status === 'completed'),
      'U had no completed route run',
    );
    c.check('R3.32', k.stages(s, exec, u, AGENT_STAGES).length === 0, 'U, with no Assignee, got an agent stage');
    const noAssignee = await routeReport(k, s, u, NO_ASSIGNEE_REPORT);
    c.check(
      'R3.32',
      noAssignee.reported,
      reportFailure(
        "U's route did not report the missing Assignee",
        noAssignee,
        noAssignee.reported ? undefined : await routeEvidence(k, s, u),
      ),
    );

    // R4.11: Closed with delivered is final.
    const after = k
      .stages(s, exec, j.a.number, ['shape', 'deliver', 'review'])
      .filter((r) => time(r.created_at) > closed(j.a.number));
    c.check('R4.11', after.length === 0, `A got ${after.map((r) => r.stage).join(', ')} after it was delivered`);
    return c.outcome(
      `B started after A was delivered and C after B, from native Blocked by only; X ignored its text dependency; U was reported`,
    );
  },
});

export const pauseAndPending: Scenario = lifecycle({
  id: 'pause-and-pending',
  concurrent: true,
  rules: ['R4.9', 'R4.10', 'R4.12', 'R4.13', 'R3.38'],
  async run(k) {
    const h = await holdJourney(k);
    const c = new Checks();
    const s = await k.obs.fresh();
    const n = h.p.number;
    if (h.pauseLate) c.notExercised('R4.12', h.pauseLate);
    else
      c.check(
        'R4.12',
        h.deliverWhilePaused === 0,
        `with pause on (Shape ${h.pauseOutcome === 'published' ? 'published, then held' : 'held before publishing'}), P had ${h.deliverWhilePaused} deliver runs`,
      );
    c.check('R3.38', h.deliverWhilePaused === 0, 'pause did not hold P');
    if (h.pendingOutcome === 'held')
      c.check(
        'R4.13',
        h.dispatchedWhilePending.length === 0,
        `with pending on (Deliver held before its PR), P got ${h.dispatchedWhilePending.join(', ')}`,
      );
    else if (h.pendingLate) c.notExercised('R4.13', h.pendingLate);
    else
      c.check('R4.13', h.reviewWhilePending === 0, `${h.reviewWhilePending} review runs started while P had pending`);
    const shapes = k.stages(s, k.exec, n, ['shape']);
    const delivers = k.stages(s, k.exec, n, ['deliver']);
    c.check(
      'R4.9',
      shapes.length > 0 && (!delivers[0] || time(shapes[0]?.created_at) < time(delivers[0].created_at)),
      'P was not shaped before Deliver',
    );
    c.check(
      'R4.10',
      delivers.some((r) => time(r.created_at) > h.editedAt),
      'P was not delivered once pause was removed',
    );
    const reviewed = k.stages(s, k.exec, n, ['review']).some((r) => time(r.created_at) >= h.unpendedAt);
    c.check('R4.13', reviewed, 'no review after pending was removed');
    c.check(
      'R4.13',
      !!k.delivered(s, k.exec, n),
      `P is not delivered: ${await k.summary(s, k.exec, n, { full: true })}`,
    );
    return c.outcome(
      `#${n}: pause held it (Shape ${h.pauseOutcome === 'published' ? 'published, then held' : 'held before publishing, redone after pause was removed'}), pending held it ${h.pendingOutcome === 'held' ? 'before its PR' : 'before review'}, and it was delivered once both were removed`,
    );
  },
});

export const shapeRewrite: Scenario = lifecycle({
  id: 'shape-rewrite',
  concurrent: true,
  rules: ['R3.13', 'R3.39', 'R3.40'],
  async run(k) {
    const h = await holdJourney(k);
    const c = new Checks();
    const s = await k.obs.fresh();
    const n = h.p.number;
    if (!c.check('R3.39', h.sentBack, 'Deliver did not send the contradicted Shape back (shaped was never removed)'))
      return c.outcome('');
    const comments = await k.obs.comments(k.exec, n);
    // Written between the edit and the re-Shape, so the later closing comment cannot stand in for it.
    const until = h.reshapedAt ?? Infinity;
    const between = (t: string) => time(t) >= h.editedAt && time(t) <= until;
    const reason = comments.find(
      (x) =>
        markerOf(x.body) &&
        !SHAPE_MARKER.test(markerOf(x.body) ?? '') &&
        (between(x.created_at) || between(x.updated_at)),
    );
    c.check('R3.39', !!reason, 'no marked comment gives the reason the Shape was sent back');
    const removed = (await k.obs.timeline(k.exec, n)).some(
      (e) => e.event === 'unlabeled' && e.label?.name === 'shaped' && time(e.created_at) >= h.editedAt,
    );
    c.check('R3.39', removed, '`shaped` was not removed after the edit');
    const shapes = comments.filter((x) => SHAPE_MARKER.test(markerOf(x.body) ?? ''));
    c.check('R3.40', shapes.length === 1, `${shapes.length} marked Shape comments, expected the one rewritten`);
    const shape = shapes[0];
    c.check(
      'R3.40',
      !!shape && time(shape.updated_at) >= h.editedAt && /quadruple/.test(shape.body ?? ''),
      'the Shape comment was not rewritten for the edited Issue (no `quadruple`)',
    );
    const reShape = await validatorProblems(k, s, k.exec, n, h.editedAt, true);
    c.none('R3.13', reShape);
    c.none(
      'R3.40',
      reShape.map((p) => `re-Shape: ${p}`),
    );
    return c.outcome(
      `#${n}: Deliver sent the Shape back with a reason, and the rewritten Shape passed a new Validator verdict`,
    );
  },
});
