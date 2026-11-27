import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import {
  Checks,
  concurrentPair,
  duplicateMarkers,
  fixPushProblems,
  githubHosted,
  hostedOnlyProblems,
  windowAt,
  isIssueBranch,
  jobWindow,
  markWindow,
  markerOf,
  parseLog,
  parseStageTitle,
  pushWakeSha,
  pushesWithin,
  queuedHoldProblems,
  reasonOf,
  sameIssueOverlaps,
  selfHosted,
  stageRuns,
  startedBefore,
} from '../../scenarios/lifecycle/analysis.ts';
import type { Activity, Job, Run, Window } from '../../scenarios/lifecycle/analysis.ts';
import { ACCEPT_END, ACCEPT_START } from '../../scenarios/lifecycle/marks.ts';

const run = (id: number, title: string, extra: Partial<Run> = {}): Run => ({
  id,
  repo: 'o/exec',
  name: 'Nibfin · Shared runner',
  display_title: title,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  created_at: `2026-11-26T10:0${id}:00Z`,
  head_sha: 'm',
  ...extra,
});

const job = (id: number, extra: Partial<Job> = {}): Job => ({
  id,
  run_id: 1,
  name: 'stage',
  status: 'completed',
  conclusion: 'success',
  labels: ['self-hosted', 'nibfin-42'],
  runner_name: 'claude-1',
  started_at: '2026-11-26T10:00:00Z',
  completed_at: '2026-11-26T10:10:00Z',
  ...extra,
});

const act = (ref: string, timestamp: string, type = 'push'): Activity => ({ id: 1, ref, timestamp, activity_type: type, before: 'a', after: 'b' });

test('stage and wake titles are parsed; stage runs are per Issue and in creation order', () => {
  deepEqual(parseStageTitle('Nibfin · o/peer#12 · deliver'), { repo: 'o/peer', issue: 12, stage: 'deliver' });
  equal(parseStageTitle('Nibfin · o/peer#12 · wake'), undefined);
  equal(pushWakeSha('Nibfin · o/exec@abc1234 · wake'), 'abc1234');
  const runs = [
    run(3, 'Nibfin · o/exec#5 · deliver'),
    run(1, 'Nibfin · o/exec#5 · route'),
    run(2, 'Nibfin · o/exec#50 · shape'),
    run(4, 'Nibfin · o/exec#5 · shape', { repo: 'o/peer' }),
  ];
  deepEqual(stageRuns(runs, 'o/exec', 'o/exec', 5).map((r) => [r.id, r.stage]), [[1, 'route'], [3, 'deliver']]);
  deepEqual(stageRuns(runs, 'o/exec', 'o/exec', 5, ['shape', 'deliver']).map((r) => r.id), [3]);
});

test('job windows: queued jobs have none, running ones are open-ended; hosted jobs are not agent jobs', () => {
  equal(jobWindow(job(1, { status: 'queued', started_at: null, completed_at: null }), 'i', 'shape'), undefined);
  equal(jobWindow(job(1, { status: 'in_progress', completed_at: null }), 'i', 'shape')?.end, Infinity);
  equal(jobWindow(job(1, { conclusion: 'cancelled', runner_name: null }), 'i', 'route'), undefined, 'cancelled before any Runner took it');
  equal(jobWindow(job(1, { conclusion: 'skipped', runner_name: '' }), 'i', 'finish'), undefined);
  equal(jobWindow(job(1, { conclusion: 'cancelled' }), 'i', 'deliver')?.runner, 'claude-1', 'cancelled while running still counts');
  equal(selfHosted(job(1)), true);
  equal(selfHosted(job(1, { labels: ['ubuntu-24.04'] })), false);
});

test('concurrent pairs need two Issues on two Runners; same-Issue overlaps are found', () => {
  const w = (issue: string, runner: string, start: number, end: number): Window => ({ issue, stage: 'deliver', jobId: start, runner, start, end });
  equal(concurrentPair([w('a', 'r1', 0, 10), w('b', 'r1', 5, 15)]), undefined);
  equal(concurrentPair([w('a', 'r1', 0, 10), w('b', 'r2', 10, 15)]), undefined);
  deepEqual(concurrentPair([w('a', 'r1', 0, 10), w('b', 'r2', 5, 15)])?.map((x) => x.issue), ['a', 'b']);
  equal(sameIssueOverlaps([w('a', 'r1', 0, 10), w('a', 'r2', 10, 20)]).length, 0);
  equal(sameIssueOverlaps([w('a', 'r1', 0, 10), w('a', 'r2', 9, 20), w('b', 'r1', 0, 30)]).length, 1);
});

test('log lines carry their leading timestamp; REASON is read from the step env', () => {
  const lines = parseLog('﻿2026-11-26T10:00:00.1234567Z ##[group]Run the stage\n2026-11-26T10:00:01.0000000Z   REASON: ci-failure\nno stamp');
  equal(lines[0]?.at, Date.parse('2026-11-26T10:00:00.123Z'));
  equal(lines[0]?.text, '##[group]Run the stage');
  deepEqual(lines[2], { text: 'no stamp' });
  equal(reasonOf(lines), 'ci-failure');
  equal(reasonOf(parseLog('2026-11-26T10:00:01Z   REASON: \n')), undefined);
});

test('a push inside the Accept window is found, one outside is not', () => {
  const lines = parseLog(['2026-11-26T10:00:00Z Accept sub agent started', '2026-11-26T10:05:00Z working', '2026-11-26T10:09:00Z Accept passed'].join('\n'));
  const w = markWindow(lines, ACCEPT_START, ACCEPT_END);
  deepEqual(w, { start: Date.parse('2026-11-26T10:00:00Z'), end: Date.parse('2026-11-26T10:09:00Z') });
  const acts = [act('refs/heads/nibfin/issue-5', '2026-11-26T10:04:00Z'), act('refs/heads/nibfin/issue-5', '2026-11-26T10:12:00Z'), act('refs/heads/x', '2026-11-26T10:05:00Z', 'branch_deletion')];
  deepEqual(pushesWithin(acts, w ?? { start: 0, end: 0 }).map((a) => a.timestamp), ['2026-11-26T10:04:00Z']);
  equal(markWindow(parseLog('Accept started\nAccept passed'), ACCEPT_START, ACCEPT_END), undefined, 'no timestamps, no window');
});

test('Issue branches and comment markers', () => {
  equal(isIssueBranch('refs/heads/nibfin/issue-5', 5), true);
  equal(isIssueBranch('nibfin/issue-5-cd-1', 5), true);
  equal(isIssueBranch('refs/heads/nibfin/issue-50', 5), false);
  equal(markerOf('text <!-- nibfin:pending --> more'), 'pending');
  equal(markerOf('plain'), undefined);
  const c = (body: string) => ({ id: 1, body, created_at: '', updated_at: '', user: null, html_url: '' });
  deepEqual(duplicateMarkers([c('<!-- nibfin:shape -->'), c('<!-- nibfin:pending -->'), c('<!-- nibfin:shape -->'), c('hi')]), ['shape ×2']);
});

test('R4.23: a held queued job passes; a moved job or a new run fails; a job that left the queue early is not exercised', () => {
  const rec = { id: 9, label: 'nibfin-42', runId: 3 };
  const queued = job(9, { status: 'queued', started_at: null, completed_at: null, runner_name: null });
  deepEqual(queuedHoldProblems(rec, queued, [run(3, 'Nibfin · o/exec#7 · shape')]), []);
  match(queuedHoldProblems(rec, { ...queued, status: 'in_progress', runner_name: 'other' }, [])[0] ?? '', /is in_progress on other, expected queued/);
  match(queuedHoldProblems(rec, { ...queued, labels: ['self-hosted', 'nibfin-7'] }, [])[0] ?? '', /expected nibfin-42/);
  match(queuedHoldProblems(rec, queued, [run(4, 'Nibfin · o/exec#7 · route')])[0] ?? '', /new runs appeared: Nibfin · o\/exec#7 · route \(4\)/);
  match(queuedHoldProblems(rec, undefined, [])[0] ?? '', /no longer listed/);
  equal(startedBefore(job(9, { status: 'in_progress', started_at: '2026-11-26T10:00:00Z' }), Date.parse('2026-11-26T10:01:00Z')), true);
  equal(startedBefore(queued, Date.parse('2026-11-26T10:01:00Z')), false);
  equal(startedBefore(job(9, { status: 'in_progress', started_at: '2026-11-26T10:02:00Z' }), Date.parse('2026-11-26T10:01:00Z')), false);
});

test('R3.20: fix pushes to another branch, a PR that does not follow the branch, or a second PR fail', () => {
  const base = {
    branch: 'nibfin/issue-5',
    prNumber: 11,
    windows: [{ start: Date.parse('2026-11-26T10:00:00Z'), end: Date.parse('2026-11-26T10:10:00Z'), reason: 'ci-failure' }],
    activity: [act('refs/heads/nibfin/issue-5', '2026-11-26T10:05:00Z')],
    headsAfter: [{ reason: 'ci-failure', prHead: 'h', branchHead: 'h' }],
    pullsForBranch: [11],
  };
  deepEqual(fixPushProblems(base), []);
  match(fixPushProblems({ ...base, activity: [act('refs/heads/nibfin/issue-5-fix', '2026-11-26T10:05:00Z')] })[0] ?? '', /pushed to refs\/heads\/nibfin\/issue-5-fix/);
  match(fixPushProblems({ ...base, headsAfter: [{ reason: 'review', prHead: 'old', branchHead: 'new' }] })[0] ?? '', /PR #11's head is old but nibfin\/issue-5 is at new/);
  match(fixPushProblems({ ...base, pullsForBranch: [11, 12] })[0] ?? '', /other PRs use nibfin\/issue-5: #12/);
});

test('Checks: problems fail with their rule; not exercised is a failure; notes are kept', () => {
  const c = new Checks();
  c.check('R1.1', true, 'unused');
  c.note('first clause only');
  deepEqual(c.outcome('ok'), { status: 'passed', reason: 'ok (first clause only)' });
  c.notExercised('R4.23', 'started early');
  c.none('R3.20', ['a', 'b']);
  deepEqual(c.outcome('ok'), { status: 'failed', reason: 'R4.23: not exercised: started early; R3.20: a; R3.20: b (first clause only)' });
});

test('the review-awaited pattern needs a wait for an approval, not any review comment', async () => {
  const { AWAITS_REVIEW, PENDING_MARKER } = await import('../../scenarios/lifecycle/marks.ts');
  for (const t of ['Waiting for an approving review before merging.', 'The merge requires 1 approving review.', 'Approval missing: needs a review by a collaborator.']) equal(AWAITS_REVIEW.test(t), true, t);
  for (const t of ['Shape review: approved, merging.', 'Review found a problem: sum subtracts.', 'Reviewed head abc1234.']) equal(AWAITS_REVIEW.test(t), false, t);
  equal(PENDING_MARKER.test(markerOf('<!-- nibfin:pending --> needs a person') ?? ''), true);
  equal(PENDING_MARKER.test(markerOf('<!-- nibfin:shape -->') ?? ''), false);
});

test('a branch creation counts as a write: a fix Deliver that opens a new branch fails R3.20', () => {
  const w = { start: Date.parse('2026-11-26T10:00:00Z'), end: Date.parse('2026-11-26T10:10:00Z'), reason: 'review' };
  const created = act('refs/heads/nibfin/issue-5-2', '2026-11-26T10:03:00Z', 'branch_creation');
  deepEqual(pushesWithin([created], w).length, 1);
  match(fixPushProblems({ branch: 'nibfin/issue-5', prNumber: 11, windows: [w], activity: [created], headsAfter: [], pullsForBranch: [11] })[0] ?? '', /pushed to refs\/heads\/nibfin\/issue-5-2/);
});

test('R3.20: a fix Deliver that pushed nothing to the PR branch is not exercised', () => {
  const w = { start: Date.parse('2026-11-26T10:00:00Z'), end: Date.parse('2026-11-26T10:10:00Z'), reason: 'ci-failure' };
  deepEqual(fixPushProblems({ branch: 'nibfin/issue-5', prNumber: 11, windows: [w], activity: [], headsAfter: [], pullsForBranch: [11] }), [
    'not exercised: the ci-failure Deliver pushed nothing to refs/heads/nibfin/issue-5',
  ]);
});

// The shapes the public sandbox's job API reports (read 2026-11-27).
const hosted = (id: number, extra: Partial<Job> = {}): Job =>
  job(id, { name: 'finish', labels: ['ubuntu-24.04'], runner_name: 'GitHub Actions 1000030032', runner_group_name: 'GitHub Actions', ...extra });
const skipped = (id: number, extra: Partial<Job> = {}): Job =>
  job(id, { status: 'completed', conclusion: 'skipped', runner_name: null, runner_group_name: null, started_at: '2026-11-26T10:00:00Z', completed_at: '2026-11-26T10:00:00Z', ...extra });

test('githubHosted takes the hosted shape and rejects self-hosted, untaken and wrong-group jobs', () => {
  equal(githubHosted(hosted(1)), true);
  equal(githubHosted(job(2, { runner_name: 'host-claude-1', runner_group_name: 'Default' })), false);
  equal(githubHosted(skipped(3, { labels: ['self-hosted', 'nibfin-42'] })), false);
  equal(githubHosted(skipped(4, { labels: ['ubuntu-24.04'] })), false);
  equal(githubHosted(hosted(5, { runner_group_name: undefined })), true);
  equal(githubHosted(hosted(6, { runner_group_name: 'Default' })), false);
  equal(githubHosted(hosted(7, { labels: ['ubuntu-24.04', 'nibfin-42'] })), false);
  equal(githubHosted(hosted(8, { status: 'queued', runner_name: null })), false);
});

test('hostedOnlyProblems judges only the jobs a runner took', () => {
  const fin = run(9, 'Nibfin · o/exec#5 · finish');
  deepEqual(hostedOnlyProblems(fin, [skipped(1, { name: 'route', labels: ['ubuntu-24.04'], conclusion: 'cancelled' }), skipped(2, { name: 'finish', labels: ['ubuntu-24.04'], conclusion: 'cancelled' })], ['claude-1']), []);
  deepEqual(hostedOnlyProblems(fin, [skipped(1, { name: 'route', labels: ['ubuntu-24.04'] }), hosted(2), skipped(3, { name: 'stage' })], ['claude-1']), []);
  const onSandbox = hostedOnlyProblems(fin, [hosted(2, { runner_name: 'claude-1' })], ['claude-1', 'claude-2']);
  equal(onSandbox.length, 1);
  match(onSandbox[0] as string, /Nibfin · o\/exec#5 · finish \(run 9\) job finish \(2\).*runner claude-1 in group GitHub Actions/);
  const selfRun = hostedOnlyProblems(fin, [job(4, { name: 'finish', runner_name: 'host-claude-1', runner_group_name: 'Default' })], []);
  equal(selfRun.length, 1);
  match(selfRun[0] as string, /job finish \(4\).*runner host-claude-1 in group Default with labels \[self-hosted, nibfin-42\] did not run on a GitHub-hosted runner/);
});

test('windowAt includes both bounds and returns nothing outside every window', () => {
  const ws = [{ start: 10, end: 20 }, { start: 30, end: Infinity }];
  equal(windowAt(10, ws), ws[0]);
  equal(windowAt(20, ws), ws[0]);
  equal(windowAt(25, ws), undefined);
  equal(windowAt(1e15, ws), ws[1]);
  equal(windowAt(NaN, ws), undefined);
  equal(windowAt(5, []), undefined);
});
