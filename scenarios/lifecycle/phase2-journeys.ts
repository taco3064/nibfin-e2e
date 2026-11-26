// Phase 2 scenarios that assert on the shared journeys (A, X, B, C, U and P).
import type { Scenario } from '../../src/types.ts';
import {
  AGENT_STAGES,
  BRANCH_WRITES,
  Checks,
  concurrentPair,
  firstMark,
  isIssueBranch,
  markWindow,
  markerOf,
  pushWakeSha,
  pushesWithin,
  sameIssueOverlaps,
  time,
} from './analysis.ts';
import type { Activity, Window } from './analysis.ts';
import { holdJourney, journey } from './journeys.ts';
import { DEADLINE, lifecycle } from './kit.ts';
import type { Kit } from './kit.ts';
import { ACCEPT_END, ACCEPT_START, BLOCKER_REPORT, NO_ASSIGNEE_REPORT, SHAPE_MARKER, VALIDATOR_VERDICT } from './marks.ts';
import type { Snapshot } from './observe.ts';
import { closingProblems } from './phase1.ts';

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * R3.13 / R3.40: the shape job's log shows a Validator verdict before the Shape comment
 * and `shaped`. A first Shape is published when the comment is created; a rewrite
 * (`rewrite`) when the existing comment is updated.
 */
async function validatorProblems(k: Kit, s: Snapshot, repo: string, n: number, after: number, rewrite = false): Promise<string[]> {
  const comment = (await k.obs.comments(repo, n)).find((x) => SHAPE_MARKER.test(markerOf(x.body) ?? ''));
  if (!comment) return [`#${n} has no marked Shape comment`];
  const published = time(rewrite ? comment.updated_at : comment.created_at);
  const shapedAt = await k.labeledAt(repo, n, 'shaped', after);
  const jobs = (await k.agentJobs(s, repo, n, ['shape'])).filter((j) => j.status === 'completed' && j.conclusion === 'success' && time(j.started_at) >= after);
  const job = jobs.at(-1);
  if (!job) return [`#${n} has no successful shape job after ${iso(after)}`];
  const verdict = firstMark(await k.obs.log(k.exec, job.id), VALIDATOR_VERDICT);
  if (!verdict) return [`shape job ${job.id} of #${n} shows no Validator verdict in its log (nothing observable)`];
  if (verdict.at === undefined) return [`the Validator verdict line of job ${job.id} has no timestamp`];
  const out: string[] = [];
  if (verdict.at > published) out.push(`the Validator verdict (${iso(verdict.at)}) comes after the Shape comment was written (${iso(published)})`);
  if (shapedAt !== undefined && verdict.at > shapedAt) out.push(`the Validator verdict (${iso(verdict.at)}) comes after \`shaped\` (${iso(shapedAt)})`);
  return out;
}

export const deliveryLifecycle: Scenario = lifecycle({
  id: 'delivery-lifecycle',
  concurrent: true,
  rules: ['R1.11', 'R3.13', 'R3.15', 'R3.16', 'R3.17', 'R3.19', 'R3.22', 'R3.23', 'R3.24', 'R3.25', 'R3.31', 'R3.33', 'R3.34', 'R3.35', 'R3.36', 'R4.7', 'R4.9', 'R4.10', 'R4.18', 'R4.34', 'R4.35', 'R6.5'],
  async run(k) {
    const j = await journey(k);
    const c = new Checks();
    const { exec } = k;
    const n = j.a.number;
    const branch = `nibfin/issue-${n}`;
    const owner = await k.owner();
    const label = await k.ownerLabel();

    c.check('R4.7', j.aBeforeScope.stageRuns === 0 && j.aBeforeScope.comments === 0, `before \`scope\`, A had ${j.aBeforeScope.stageRuns} stage runs and ${j.aBeforeScope.comments} comments`);
    const s = await k.obs.fresh();
    c.none('R3.13', await validatorProblems(k, s, exec, n, j.aScopedAt));

    // R4.9, R4.10: Shape before Deliver, Deliver only once `shaped`.
    const firstDeliver = k.stages(s, exec, n, ['deliver'])[0];
    const shapedAt = await k.labeledAt(exec, n, 'shaped');
    c.check('R4.9', k.stages(s, exec, n, ['shape']).length > 0, 'A was never shaped');
    c.check('R4.10', !!firstDeliver && shapedAt !== undefined && time(firstDeliver.created_at) >= shapedAt, `A's first deliver run (${String(firstDeliver?.created_at)}) is not after \`shaped\``);

    // R3.15, R6.5: only the Writer writes the branch; the Validator and the Acceptor never push.
    const windows = await k.windows(s, exec, n, true);
    const acts = (await k.obs.activity(exec, { ref: `refs/heads/${branch}` })).filter((a) => BRANCH_WRITES.has(a.activity_type));
    const inside = (a: Activity, w: Window) => time(a.timestamp) >= w.start && time(a.timestamp) <= w.end;
    for (const a of acts) {
      const ws = windows.filter((w) => inside(a, w));
      c.check('R3.15', ws.some((w) => w.stage === 'deliver'), `the ${a.activity_type} at ${a.timestamp} to ${branch} is outside every deliver job of A`);
      const other = ws.find((w) => w.stage === 'shape' || w.stage === 'review');
      c.check('R6.5', !other, `the ${a.activity_type} at ${a.timestamp} falls inside A's ${other?.stage} job ${other?.jobId}`);
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
      c.check('R6.5', pushed.length === 0, `${pushed.length} push(es) to ${branch} during the Accept check of job ${dj.id}`);
      if (w.end <= time(pr.created_at) && time(dj.started_at) <= time(pr.created_at)) acceptBeforePr = true;
    }
    c.check('R3.19', acceptBeforePr, `no Accept check ended before PR #${pr.number} was created at ${pr.created_at}`);
    const prs = await k.obs.pullsByHead(exec, branch);
    c.check('R3.16', prs.length === 1 && pr.head.ref === branch, `${prs.length} PRs use ${branch}; A's PR head is ${pr.head.ref}`);

    // R4.35: the two wakes during Deliver started no stage again.
    const toggled = await k.obs.job(exec, j.wakeToggles.jobId);
    const from = j.wakeToggles.at[0] ?? 0;
    const to = toggled.completed_at ? time(toggled.completed_at) : k.now();
    if (to <= (j.wakeToggles.at.at(-1) ?? 0)) c.notExercised('R4.35', `deliver job ${toggled.id} completed at ${String(toggled.completed_at)}, before the wakes ended`);
    else {
      const again = k.stages(s, exec, n, AGENT_STAGES).filter((r) => time(r.created_at) >= from && time(r.created_at) <= to);
      c.check('R4.35', again.length === 0, `while Deliver ran, the wakes started ${again.map((r) => r.stage).join(', ')}`);
    }

    // R3.22–R3.25, R3.33: review after the required `test` completed on the reviewed head, and that head merged.
    const head = pr.head.sha;
    const test = (await k.obs.checkRuns(exec, head)).find((x) => x.name === 'test');
    c.check('R3.33', test?.status === 'completed' && test.conclusion === 'success', `the required check test on ${head} is ${String(test?.status)}/${String(test?.conclusion)}`);
    const reviews = (await k.agentJobs(s, exec, n, ['review'])).filter((x) => time(x.started_at) < time(pr.merged_at));
    const lastReview = reviews.at(-1);
    if (!lastReview) c.fail('R3.23', 'no review job ran before the merge');
    else {
      c.check('R3.22', test?.completed_at !== null && time(lastReview.started_at) >= time(test?.completed_at), `review job ${lastReview.id} started before test completed on ${head}`);
      c.check('R3.23', time(lastReview.started_at) >= time(test?.completed_at), 'the review was not dispatched after PR CI completed');
      const late = acts.filter((a) => time(a.timestamp) > time(lastReview.started_at) && time(a.timestamp) < time(pr.merged_at));
      c.check('R3.25', late.length === 0, `${branch} changed after the last review started and before the merge (${late.map((a) => a.after.slice(0, 7)).join(', ')})`);
      c.check('R3.24', !!pr.merged_at, 'the reviewed PR was not merged');
    }

    // R3.31, R3.34–R3.36: CD is the merge's push runs; closure waits for all of them.
    c.check('R3.35', s.runs.some((r) => r.repo === exec && j.mergeSha.startsWith(pushWakeSha(r.display_title) ?? '-')), `no \`@${j.mergeSha.slice(0, 7)} · wake\` run in ${exec}`);
    c.check('R3.34', j.openWhileCdHeld, 'A closed while CD of its merge was still running');
    c.check('R3.36', j.openAfterCd, 'A closed while a new CI run attempt of its merge was still running');
    const a = k.issue(s, exec, n);
    c.check('R3.31', a?.state === 'closed' && a.state_reason === 'completed' && k.labels(s, exec, n).includes('delivered'), `A is ${String(a?.state)}/${String(a?.state_reason)} [${k.labels(s, exec, n).join(', ')}]`);
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
    for (const d of deletions) c.check('R3.17', time(d.timestamp) >= closedAt, `${d.ref} was deleted at ${d.timestamp}, before A closed at ${String(a?.closed_at)}`);

    // R4.34, R4.18: Nibfin writes as the init credential's login and routes by Assignee.
    c.check('R4.34', pr.user?.login === owner.login, `PR #${pr.number} was opened by ${String(pr.user?.login)}, not ${owner.login}`);
    for (const cm of (await k.obs.comments(exec, n)).filter((x) => markerOf(x.body))) {
      c.check('R4.34', cm.user?.login === owner.login, `marked comment ${cm.html_url} is by ${String(cm.user?.login)}`);
    }
    const strays = (await k.agentJobs(s, exec, n)).filter((x) => !x.labels.includes(label));
    c.check('R4.18', strays.length === 0, `A's agent jobs ran on ${strays.map((x) => x.labels.join('+')).join(', ')}, not ${label}`);
    return c.outcome(`#${n} went Shape → Deliver → PR CI → review → merge → CD → delivered (PR #${pr.number}, ${j.mergeSha.slice(0, 7)})`);
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
    const issues = [j.a, j.x, j.b, j.c].map((i) => i.number);
    const agent: Window[] = [];
    const all: Window[] = [];
    for (const n of issues) {
      agent.push(...(await k.windows(s, exec, n)));
      all.push(...(await k.windows(s, exec, n, true)));
    }
    const inJourney = (w: Window) => w.start >= j.startedAt && w.start <= j.endedAt;
    const pair = concurrentPair(agent.filter(inJourney));
    c.check('R6.5', pair !== undefined, 'no two agent jobs of different Issues ran at the same time on two Runners');
    const writers = sameIssueOverlaps(agent.filter((w) => w.stage === 'deliver'));
    c.check('R6.5', writers.length === 0, `two Writers overlapped on ${writers.map(([a]) => a.issue).join(', ')}`);
    for (const [a, b] of sameIssueOverlaps(all)) {
      const what = `${a.issue}: ${a.stage} job ${a.jobId} and ${b.stage} job ${b.jobId} overlapped`;
      c.fail('R4.25', what);
      c.fail('R4.36', what);
    }
    // R4.17: X asked for codex in its text and NIBFIN_PROVIDER=codex is set; it ran on this host's Claude Runners.
    const names = (await k.obs.runners(exec)).map((r) => r.name);
    const xJobs = await k.agentJobs(s, exec, j.x.number);
    c.check('R4.17', k.delivered(s, exec, j.x.number) !== undefined, `X is not delivered: ${await k.summary(s, exec, j.x.number)}`);
    const foreign = xJobs.filter((x) => !names.includes(x.runner_name ?? ''));
    c.check('R4.17', xJobs.length > 0 && foreign.length === 0, `X's agent jobs ran on ${foreign.map((x) => String(x.runner_name)).join(', ') || 'nothing'}, not only this host's Claude Runners (${names.join(', ')})`);
    return c.outcome(pair ? `${pair[0].issue} and ${pair[1].issue} ran at once on ${pair[0].runner} and ${pair[1].runner}; no Issue ever had two jobs at once` : 'parallel');
  },
});

/** Whether the route of an Issue reported something, in its job log or a marked comment. */
async function reported(k: Kit, s: Snapshot, n: number, pattern: RegExp, before = Infinity): Promise<boolean> {
  for (const job of await k.stageJobs(s, k.exec, n, ['route'])) {
    if (job.status !== 'completed' || time(job.completed_at) > before) continue;
    if ((await k.obs.log(k.exec, job.id)).some((l) => pattern.test(l.text))) return true;
  }
  // Only comments written by then: a later Shape or closing comment may name the dependency too.
  return (await k.obs.comments(k.exec, n)).some((x) => markerOf(x.body) && pattern.test(x.body ?? '') && time(x.created_at) <= before);
}

export const blockedByChain: Scenario = lifecycle({
  id: 'delivery-blocked-by-chain',
  concurrent: true,
  rules: ['R3.31', 'R3.32', 'R4.11', 'R4.28', 'R4.29', 'R4.30'],
  async run(k) {
    const j = await journey(k);
    const c = new Checks();
    const { exec } = k;
    const s = await k.obs.fresh();
    const closed = (n: number) => time(k.issue(s, exec, n)?.closed_at);
    const firstAgent = (n: number) => k.stages(s, exec, n, AGENT_STAGES)[0];

    // R4.28: only native Blocked by counts; X's "Blocked by #C" text does not hold it back.
    const x0 = firstAgent(j.x.number);
    c.check('R4.28', !!x0 && time(x0.created_at) < closed(j.c.number), `X's first agent stage run (${String(x0?.created_at)}) waited for C, which X only names in text`);

    for (const [name, n, up, upName, lastWrite] of [
      ['B', j.b.number, j.a.number, 'A', j.lastWrite.b],
      ['C', j.c.number, j.b.number, 'B', j.lastWrite.c],
    ] as const) {
      const upClosed = closed(up);
      const early = k.stages(s, exec, n, AGENT_STAGES).filter((r) => time(r.created_at) < upClosed);
      c.check('R4.29', early.length === 0, `${name} started ${early.map((r) => r.stage).join(', ')} before ${upName} closed`);
      const routed = k.stages(s, exec, n, ['route']).some((r) => r.status === 'completed' && time(r.updated_at) < upClosed);
      c.check('R3.32', routed, `${name} had no completed route run while ${upName} was open`);
      c.check('R3.32', await reported(k, s, n, BLOCKER_REPORT, upClosed), `${name}'s route did not report its open blocker`);
      const start = firstAgent(n);
      c.check('R4.29', !!start && time(start.created_at) >= upClosed, `${name}'s first agent stage run (${String(start?.created_at)}) is not after ${upName} closed`);
      c.check('R4.30', lastWrite < upClosed && !!start, `${name} was not woken without a harness write after ${upName} closed`);
      c.check('R3.31', !!k.delivered(s, exec, up) && !!start, `${upName}'s closure did not lead to ${name}`);
    }

    // R3.32: no Assignee is reported, with no stage.
    const u = j.u.number;
    c.check('R3.32', k.stages(s, exec, u, ['route']).some((r) => r.status === 'completed'), 'U had no completed route run');
    c.check('R3.32', k.stages(s, exec, u, AGENT_STAGES).length === 0, 'U, with no Assignee, got an agent stage');
    c.check('R3.32', await reported(k, s, u, NO_ASSIGNEE_REPORT), 'U\'s route did not report the missing Assignee');

    // R4.11: Closed with delivered is final.
    const after = k.stages(s, exec, j.a.number, ['shape', 'deliver', 'review']).filter((r) => time(r.created_at) > closed(j.a.number));
    c.check('R4.11', after.length === 0, `A got ${after.map((r) => r.stage).join(', ')} after it was delivered`);
    return c.outcome(`B started after A was delivered and C after B, from native Blocked by only; X ignored its text dependency; U was reported`);
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
    c.check('R4.12', h.shapedWhilePaused && h.deliverWhilePaused === 0, `with pause on, P had shaped=${h.shapedWhilePaused} and ${h.deliverWhilePaused} deliver runs`);
    c.check('R3.38', h.deliverWhilePaused === 0, 'pause did not hold P');
    if (h.pendingLate) c.notExercised('R4.13', h.pendingLate);
    else c.check('R4.13', h.reviewWhilePending === 0, `${h.reviewWhilePending} review runs started while P had pending`);
    const shapes = k.stages(s, k.exec, n, ['shape']);
    const delivers = k.stages(s, k.exec, n, ['deliver']);
    c.check('R4.9', shapes.length > 0 && (!delivers[0] || time(shapes[0]?.created_at) < time(delivers[0].created_at)), 'P was not shaped before Deliver');
    c.check('R4.10', delivers.some((r) => time(r.created_at) > h.editedAt), 'P was not delivered once pause was removed');
    const reviewed = k.stages(s, k.exec, n, ['review']).some((r) => time(r.created_at) >= h.unpendedAt);
    c.check('R4.13', reviewed, 'no review after pending was removed');
    c.check('R4.13', !!k.delivered(s, k.exec, n), `P is not delivered: ${await k.summary(s, k.exec, n)}`);
    return c.outcome(`#${n}: pause held it after Shape, pending held it before review, and it was delivered once both were removed`);
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
    if (!c.check('R3.39', h.sentBack, 'Deliver did not send the contradicted Shape back (shaped was never removed)')) return c.outcome('');
    const comments = await k.obs.comments(k.exec, n);
    // Written between the edit and the re-Shape, so the later closing comment cannot stand in for it.
    const until = h.reshapedAt ?? Infinity;
    const between = (t: string) => time(t) >= h.editedAt && time(t) <= until;
    const reason = comments.find((x) => markerOf(x.body) && !SHAPE_MARKER.test(markerOf(x.body) ?? '') && (between(x.created_at) || between(x.updated_at)));
    c.check('R3.39', !!reason, 'no marked comment gives the reason the Shape was sent back');
    const removed = (await k.obs.timeline(k.exec, n)).some((e) => e.event === 'unlabeled' && e.label?.name === 'shaped' && time(e.created_at) >= h.editedAt);
    c.check('R3.39', removed, '`shaped` was not removed after the edit');
    const shapes = comments.filter((x) => SHAPE_MARKER.test(markerOf(x.body) ?? ''));
    c.check('R3.40', shapes.length === 1, `${shapes.length} marked Shape comments, expected the one rewritten`);
    const shape = shapes[0];
    c.check('R3.40', !!shape && time(shape.updated_at) >= h.editedAt && /quadruple/.test(shape.body ?? ''), 'the Shape comment was not rewritten for the edited Issue (no `quadruple`)');
    const reShape = await validatorProblems(k, s, k.exec, n, h.editedAt, true);
    c.none('R3.13', reShape);
    c.none('R3.40', reShape.map((p) => `re-Shape: ${p}`));
    return c.outcome(`#${n}: Deliver sent the Shape back with a reason, and the rewritten Shape passed a new Validator verdict`);
  },
});
