// Proposal R3.27: a submitted PR review wakes the Issue. A changes-requested review sends
// a review fix to Deliver; an approval that meets the requirement lets the merge continue.
//
// One fixture runs alone under a repository-wide ruleset requiring one approving review
// (Proposal R3.25, R3.26). Once Nibfin's review says the merge waits for an approval, the
// collaborator account (a write collaborator; the Owner cannot review the PR Nibfin opened
// with the Owner's credential, R3.29) requests one checkable change, then approves the
// fixed head. Between the reviews the harness adds no label, comment or dispatch: only
// the review events can wake the Issue.
import { GitHubError } from '../../src/host/github.ts';
import type { Scenario } from '../../src/types.ts';
import { Checks, reasonOf, time } from './analysis.ts';
import type { Activity, Pull } from './analysis.ts';
import { DEADLINE, changeRequest, lifecycle, message } from './kit.ts';
import type { Kit } from './kit.ts';
import { APPROVAL_RULE, awaitingReview } from './phase1.ts';

const RULE = 'R3.27';
const RULESET = 'e2e-review-approval';
/** The function the changes-requested review asks for. */
const ASKED = 'half';

/** A submitted review as GitHub returns it. */
export interface Review {
  id: number;
  state: string;
  commit_id: string;
  submitted_at?: string | null;
  user?: { login: string } | null;
}

/** What is wrong with a review GitHub created for `event` on `commit`. */
export function reviewProblems(r: Review, state: 'CHANGES_REQUESTED' | 'APPROVED', commit: string, pr: number): string[] {
  const out: string[] = [];
  if (r.state !== state) out.push(`review ${r.id} on PR #${pr} has state ${r.state}, expected ${state}`);
  if (r.commit_id !== commit) out.push(`review ${r.id} on PR #${pr} is on ${r.commit_id}, expected ${commit}`);
  if (!r.submitted_at || Number.isNaN(time(r.submitted_at))) out.push(`review ${r.id} on PR #${pr} has no submitted_at`);
  return out;
}

/** A deliver agent job of the fixture with its REASON line, when read. */
export interface FixJob {
  id: number;
  created_at: string | null | undefined;
  completed_at: string | null;
  status: string;
  conclusion: string | null;
  reason?: string;
}

export interface FixEvidence {
  pr: number;
  review: { id: number; submitted_at: string };
  /** The head the review was submitted on. */
  reviewed: string;
  /** The PR head after the fix. */
  head: string;
  /** The fixture's deliver agent jobs. */
  jobs: FixJob[];
  /** Pushes to the fixture's branch. */
  pushes: Pick<Activity, 'timestamp' | 'activity_type' | 'after'>[];
  /** The fixture's source file at `head`. */
  content: string | undefined;
  file: string;
}

const at = (e: { review: { submitted_at: string } }) => time(e.review.submitted_at);
const named = (e: { pr: number; review: { id: number; submitted_at: string } }) => `PR #${e.pr} review ${e.review.id} (submitted ${e.review.submitted_at})`;

/** The deliver jobs created at or after the review, oldest first. */
export function fixJobs(e: { jobs: FixJob[]; review: { submitted_at: string } }): FixJob[] {
  return e.jobs.filter((j) => time(j.created_at) >= at(e)).sort((a, b) => time(a.created_at) - time(b.created_at));
}

/** When the last completed deliver job after the review ended (the review time when none did): Nibfin's next review-awaited comment comes after it. */
export function fixDoneAt(e: { jobs: FixJob[]; review: { submitted_at: string } }): number {
  return Math.max(at(e), ...fixJobs(e).map((j) => time(j.completed_at)).filter((t) => !Number.isNaN(t)));
}

/** What breaks R3.27 for the changes-requested review: no review-fix Deliver after it, no push, or a head without the asked change. */
export function reviewFixProblems(e: FixEvidence): string[] {
  const out: string[] = [];
  const late = fixJobs(e);
  const done = late.filter((j) => j.status === 'completed');
  if (!late.length) {
    const seen = e.jobs.map((j) => `${j.id} (created ${String(j.created_at)})`).join(', ') || 'none';
    out.push(`no deliver job started after ${named(e)}; deliver jobs seen: ${seen}`);
  } else if (!done.length) out.push(`no deliver job after ${named(e)} completed: ${late.map((j) => `${j.id} (${j.status})`).join(', ')}`);
  else if (!done.some((j) => j.reason === 'review')) out.push(`the deliver jobs after ${named(e)} carry REASON ${done.map((j) => `${j.reason ?? 'unknown'} (job ${j.id})`).join(', ')}, expected review`);
  const pushes = e.pushes.filter((p) => p.activity_type !== 'branch_deletion' && time(p.timestamp) >= at(e));
  if (!pushes.length) out.push(`no push to the branch after ${named(e)}`);
  if (e.head === e.reviewed) out.push(`PR #${e.pr}'s head is still the reviewed ${e.reviewed}`);
  else if (e.content === undefined) out.push(`${e.file} is missing at the new head ${e.head}`);
  else if (!new RegExp(`\\b${ASKED}\\b`).test(e.content)) out.push(`${e.file} at the new head ${e.head} has no \`${ASKED}\`, the change ${named(e)} asked for`);
  return out;
}

export interface MergeEvidence {
  pr: number;
  review: { id: number; submitted_at: string };
  /** The head the approval was submitted on. */
  fixed: string;
  merged?: Pick<Pull, 'number' | 'merged_at'> & { head: string };
  delivered: boolean;
}

/** What breaks R3.27 for the approval: no merge after it, a merge of another head, or no closure with `delivered`. */
export function approvalMergeProblems(e: MergeEvidence): string[] {
  const out: string[] = [];
  if (!e.merged) out.push(`PR #${e.pr} did not merge after ${named(e)}`);
  else {
    if (!(time(e.merged.merged_at) >= at(e))) out.push(`PR #${e.merged.number} merged at ${String(e.merged.merged_at)}, before ${named(e)}`);
    if (e.merged.head !== e.fixed) out.push(`PR #${e.merged.number} merged head ${e.merged.head}, not the approved ${e.fixed}`);
  }
  if (!e.delivered) out.push(`the Issue did not close with delivered after ${named(e)}`);
  return out;
}

/** The review body: one concrete, checkable change in the fixture's files. */
export function reviewBody(slug: string): string {
  return [
    `Please also export a function \`${ASKED}(n)\` from \`src/${slug}.js\` that returns \`n / 2\`, with a \`node:test\` case for it in \`test/${slug}.test.js\`.`,
    'Change nothing else.',
    '_This review is an automated nibfin-e2e fixture._',
  ].join('\n\n');
}

/** Submits a review as the collaborator; a refused review fails naming the status and that widening the token is the Owner's decision. */
async function submit(k: Kit, pr: number, body: Record<string, unknown>): Promise<Review> {
  try {
    const { data } = await k.ctx.peer().github.rest<Review>('POST', `/repos/${k.exec}/pulls/${pr}/reviews`, body);
    return data;
  } catch (error) {
    const status = error instanceof GitHubError ? ` (HTTP ${error.status})` : '';
    throw new Error(`${RULE}: the collaborator could not submit a ${String(body.event)} review on PR #${pr}${status}: ${message(error)}; widening E2E_PEER_GITHUB_TOKEN is an Owner decision`, { cause: error });
  }
}

export const reviewEvents: Scenario = lifecycle({
  id: 'review-events',
  rules: [RULE],
  requires: ['collaborator'],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    let n: number | undefined;
    try {
      const peer = k.ctx.peer();
      const owner = await k.owner();
      await k.ruleset(RULESET, [APPROVAL_RULE]);
      const slug = k.slug('re');
      const file = `src/${slug}.js`;
      const issue = await k.file(exec, { scenario: 'review-events', title: 'Add double', body: changeRequest(slug, 'double', 'returns its argument times two'), labels: ['scope'], assignees: [owner.login] });
      const num = (n = issue.number);
      const branch = `nibfin/issue-${num}`;
      const show = k.show(exec, num);
      const prOf = (s: { pulls: Map<string, Pull[]> }) => s.pulls.get(exec)?.find((p) => p.head.ref === branch);

      // 1–2: the PR waits for an approving review (R3.26), without pending and unmerged.
      const pr0 = await k.obs.until(`#${num}'s PR`, (s) => prOf(s), DEADLINE.stage, show, { gonePast: k.closeGone(exec, num) });
      const prn = pr0.number;
      const waits = await k.obs.until(
        `a marked comment on PR #${prn} saying the merge waits for a review`,
        async (s) => {
          const reviewed = (await k.agentJobs(s, exec, num, ['review'])).map((j) => time(j.started_at)).filter((t) => !Number.isNaN(t));
          if (!reviewed.length) return undefined;
          return awaitingReview(await k.obs.comments(exec, prn), Math.min(...reviewed)) ? s : undefined;
        },
        DEADLINE.stage,
        show,
        { gonePast: k.closeGone(exec, num) },
      );
      const calm = await k.settle(`the review-awaited comment on PR #${prn}`, waits.at, k.runsOf(exec, num));
      const pr = prOf(calm) ?? pr0;
      if (pr.merged_at) return { status: 'failed', reason: `${RULE}: not exercised: PR #${prn} merged at ${pr.merged_at} while the approval rule was in force, before any review` };
      if (k.labels(calm, exec, num).includes('pending')) return { status: 'failed', reason: `${RULE}: not exercised: #${num} has pending while PR #${prn} waits for a review; ${await show(calm)}` };
      if (pr.user?.login === peer.login) return { status: 'failed', reason: `${RULE}: not exercised: PR #${prn} is authored by the collaborator ${peer.login}, who cannot review it` };
      const reviewed = pr.head.sha;
      const before = await k.fileOn(exec, reviewed, file);
      if (before !== undefined && new RegExp(`\\b${ASKED}\\b`).test(before)) return { status: 'failed', reason: `${RULE}: not exercised: ${file} at PR #${prn}'s head ${reviewed} already has \`${ASKED}\`` };

      // 3: the collaborator requests changes on the current head. From here the harness only reads.
      const asked = await submit(k, prn, { commit_id: reviewed, event: 'REQUEST_CHANGES', body: reviewBody(slug) });
      if (!c.none(RULE, reviewProblems(asked, 'CHANGES_REQUESTED', reviewed, prn))) return c.outcome('');
      const askedAt = asked.submitted_at as string;
      const askedName = `PR #${prn} review ${asked.id} (changes requested, submitted ${askedAt})`;
      k.ctx.log(`review-events: ${askedName} on ${reviewed}`);

      // 4: only that review wakes the Issue: a deliver job after it, completed, with a new head.
      const fix = await k.obs.until(
        `a deliver job of #${num} after ${askedName} and a new head`,
        async (s) => {
          const head = prOf(s)?.head.sha;
          if (!head || head === reviewed) return undefined;
          const job = (await k.agentJobs(s, exec, num, ['deliver'])).find((j) => time(j.created_at ?? j.run.created_at) >= time(askedAt) && j.status === 'completed');
          return job ? { job, head, s } : undefined;
        },
        DEADLINE.stage,
        show,
        { gonePast: k.stageGone(exec, num, 'deliver', { since: time(askedAt), jobs: false }) },
      );
      const jobs: FixJob[] = [];
      for (const j of await k.agentJobs(fix.s, exec, num, ['deliver'])) {
        const created = j.created_at ?? j.run.created_at;
        let reason: string | undefined;
        if (time(created) >= time(askedAt) && j.status === 'completed') {
          try {
            reason = reasonOf(await k.obs.log(exec, j.id));
          } catch (error) {
            reason = `unreadable: ${message(error)}`;
          }
        }
        jobs.push({ id: j.id, created_at: created, completed_at: j.completed_at, status: j.status, conclusion: j.conclusion, reason });
      }
      const fixProblems = reviewFixProblems({
        pr: prn,
        review: { id: asked.id, submitted_at: askedAt },
        reviewed,
        head: fix.head,
        jobs,
        pushes: await k.obs.activity(exec, { ref: `refs/heads/${branch}` }),
        content: await k.fileOn(exec, fix.head, file),
        file,
      });
      const wakes = fix.s.runs.filter((r) => r.repo === exec && r.event === 'pull_request_review' && time(r.created_at) >= time(askedAt));
      c.note(`runs on pull_request_review after review ${asked.id}: ${wakes.map((r) => `${r.name} ${r.id}`).join(', ') || 'none'}`);
      if (!c.none(RULE, fixProblems)) return c.outcome('');

      // 5: the review again waits for an approval on the new head.
      const fixedAt = fixDoneAt({ jobs, review: { submitted_at: askedAt } });
      const again = await k.obs.until(
        `a marked comment on PR #${prn} saying the merge of the fixed head waits for a review`,
        async (s) => {
          const cur = prOf(s);
          if (cur?.merged_at) return s;
          return awaitingReview(await k.obs.comments(exec, prn), fixedAt) ? s : undefined;
        },
        DEADLINE.stage,
        show,
        { gonePast: k.closeGone(exec, num) },
      );
      const calm2 = await k.settle(`the review-awaited comment on PR #${prn} after the fix`, again.at, k.runsOf(exec, num));
      const pr2 = prOf(calm2);
      if (!pr2) return { status: 'failed', reason: `${RULE}: PR #${prn} is no longer listed after the review fix` };
      c.check('R3.27', !pr2.merged_at, `PR #${prn} merged at ${String(pr2.merged_at)} after ${askedName}, without an approval`);
      c.check('R3.27', !k.labels(calm2, exec, num).includes('pending'), `#${num} has pending after the review fix of ${askedName}; ${await show(calm2)}`);
      if (c.failed) return c.outcome('');
      const fixed = pr2.head.sha;

      // 6: the same collaborator approves the fixed head; that approval alone lets the merge continue.
      const approval = await submit(k, prn, { commit_id: fixed, event: 'APPROVE', body: 'Approved by the nibfin-e2e collaborator.' });
      if (!c.none(RULE, reviewProblems(approval, 'APPROVED', fixed, prn))) return c.outcome('');
      const approvedAt = approval.submitted_at as string;
      const approvedName = `PR #${prn} review ${approval.id} (approved, submitted ${approvedAt})`;
      k.ctx.log(`review-events: ${approvedName} on ${fixed}`);
      await k.obs.until(`#${num} to close with delivered after ${approvedName}`, (s) => k.delivered(s, exec, num), DEADLINE.delivery, show, { gonePast: k.closeGone(exec, num) });
      const s = await k.obs.fresh();
      const merged = (await k.obs.pullsByHead(exec, branch)).find((p) => p.merged_at);
      c.none(
        RULE,
        approvalMergeProblems({
          pr: prn,
          review: { id: approval.id, submitted_at: approvedAt },
          fixed,
          merged: merged ? { number: merged.number, merged_at: merged.merged_at, head: merged.head.sha } : undefined,
          delivered: !!k.delivered(s, exec, num),
        }),
      );
      return c.outcome(`#${num}: ${askedName} alone led to a review-fix Deliver that added \`${ASKED}\` (${fix.head}); ${approvedName} alone let PR #${prn} merge and #${num} close with delivered`);
    } finally {
      await k.deleteRuleset(RULESET).catch((e: unknown) => k.ctx.log(`deleting ${RULESET} failed: ${message(e)}`));
      await k.pauseOpen(exec, [n]);
    }
  },
});
