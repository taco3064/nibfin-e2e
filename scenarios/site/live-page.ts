// Proposal R9.40, R9.44, R9.11 and R9.2: the public site's Live page.
import type { Locator, Page } from 'playwright-core';
import type { GitHub } from '../../src/host/github.ts';
import {
  TOKEN_PATTERN,
  check,
  fail,
  issueHeading,
  liveLeaks,
  messageKind,
  noTrackIssueMessage,
  pickTrackIssue,
  snapshotOpenIssues,
  snapshotRepos,
  stageOf,
  trackProblem,
} from '../dashboard/checks.ts';
import { openIssues, readIssue, sleep, until } from '../dashboard/github.ts';
import type { Issue } from '../dashboard/github.ts';
import { bodyText, currentStage, defineScenario, escapeRe, openPage } from '../dashboard/support.ts';

export const LIVE_URL = 'https://taco3064.github.io/gh-nibfin/live/';
export const NIBFIN_REPOS = ['nibfin-core', 'gh-nibfin', 'nibfin-e2e'];
const OWNER = 'taco3064';

/** Self-hosted runner names from the three repositories' recent Nibfin job records. */
async function selfHostedRunnerNames(gh: GitHub): Promise<string[]> {
  const names = new Set<string>();
  for (const repo of NIBFIN_REPOS) {
    const { data } = await gh.rest<{ workflow_runs: { id: number; name: string }[] }>('GET', `/repos/${OWNER}/${repo}/actions/runs?per_page=30`);
    for (const run of data.workflow_runs.filter((r) => /^nibfin\b/i.test(r.name)).slice(0, 15)) {
      const jobs = await gh.rest<{ jobs: { runner_name: string | null; labels: string[] }[] }>('GET', `/repos/${OWNER}/${repo}/actions/runs/${run.id}/jobs`);
      for (const j of jobs.data.jobs) if (j.runner_name && j.labels.includes('self-hosted')) names.add(j.runner_name);
    }
  }
  return [...names];
}

const quote = (text: string) => JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 600));

/** The repository the collapsed Live picker names ("Repository OWNER/REPO"), if any. */
async function shownLiveRepo(page: Page): Promise<string | undefined> {
  const text = await bodyText(page);
  return NIBFIN_REPOS.find((r) => new RegExp(`\\bRepository\\s+${OWNER}/${escapeRe(r)}(?![\\w-])`).test(text));
}

/** Shows one repository through the Live picker: its Change button, then the repository's entry. */
async function showLiveRepo(page: Page, repo: string): Promise<void> {
  if ((await shownLiveRepo(page)) === repo) return;
  const change = page.getByRole('button', { name: /^change$/i });
  if (await change.count()) await change.first().click();
  const entry = page.getByRole('button', { name: new RegExp(`\\b${OWNER}/${escapeRe(repo)}(?![\\w-])`) });
  if (!(await entry.count())) fail('R9.2', `a repository picker entry for ${OWNER}/${repo} on the Live page`, `page text: ${quote(await bodyText(page))}`);
  await entry.first().click();
}

const stageList = (scope: Locator) => scope.getByRole('list', { name: 'Stage', exact: true });

/**
 * The Issue's own element: the article headed "#<number> <title>", preferring one with a
 * Stage list. Blocker chips and blocker cards never match the heading.
 */
async function liveIssueElement(page: Page, issue: Issue): Promise<Locator | undefined> {
  const candidates = page.getByRole('article').filter({ has: page.getByRole('heading', { name: issueHeading(issue.number, issue.title) }) });
  const n = await candidates.count();
  for (let i = 0; i < n; i++) if (await stageList(candidates.nth(i)).count()) return candidates.nth(i);
  return n ? candidates.first() : undefined;
}

/** Reads the Issue's stage track on the Live page; fails R9.2 when the element or its track is missing. */
async function readTrack(page: Page, issue: Issue): Promise<{ text: string; stepsProblem?: string; problem?: string }> {
  const what = `the Issue element of ${issue.repo}#${issue.number} (${issue.title}) on the Live page`;
  const el = await until(() => liveIssueElement(page, issue), (e) => e !== undefined, 15_000, 1000);
  if (!el) fail('R9.2', what, `no such element; page text: ${quote(await bodyText(page))}`);
  const text = await el.innerText();
  const track = stageList(el);
  if (!(await track.count())) fail('R9.2', `${what} with its Shape → Deliver → Done track`, `no Stage track; element text: ${quote(text)}`);
  const steps = await track.first().getByRole('listitem').allTextContents();
  const current = await currentStage(track.first());
  return { text, stepsProblem: trackProblem(steps, current, undefined), problem: trackProblem(steps, current, stageOf(issue.labels)) };
}

export const livePage = defineScenario({
  id: 'live-page',
  rules: ['R9.40', 'R9.44', 'R9.11', 'R9.2'],
  async run(ctx) {
    const { page } = await openPage(ctx);
    const sockets: string[] = [];
    const frames: { at: number; data: unknown; raw: string }[] = [];
    const scripts: string[] = [];
    page.on('websocket', (ws) => {
      sockets.push(ws.url());
      ws.on('framereceived', (f) => {
        const raw = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8');
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          data = undefined;
        }
        frames.push({ at: Date.now(), data, raw });
      });
    });
    page.on('response', (r) => {
      if (r.request().resourceType() === 'script') r.text().then((t) => scripts.push(t), () => {});
    });
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    const kinds = () => frames.map((f) => messageKind(f.data));
    const end = Date.now() + 90_000;
    while (Date.now() < end && frames.filter((f) => messageKind(f.data) === 'checked').length < 2) await sleep(1000);

    // R9.44: the Worker pushes over WebSocket; no token reaches the browser.
    check(sockets.length, 'R9.44', 'the Live page to open a WebSocket', 'none');
    for (const s of sockets) check(!/(^|\.)github(usercontent)?\.com$/.test(new URL(s).hostname), 'R9.44', 'the socket to go to the Worker, not GitHub', s);
    const snapIdx = kinds().indexOf('snapshot');
    check(snapIdx >= 0, 'R9.44', 'a snapshot message', `kinds ${kinds().join(', ') || 'none'}`);
    const checked = frames.filter((f) => messageKind(f.data) === 'checked');
    check(checked.length >= 1 && frames.indexOf(checked[0] as (typeof frames)[number]) > snapIdx, 'R9.44', 'checked events after the snapshot', `kinds ${kinds().join(', ')}`);
    const ats = checked.map((f) => Date.parse(String((f.data as Record<string, unknown>).at ?? '')));
    check(ats.length >= 2 && (ats[ats.length - 1] as number) > (ats[0] as number), 'R9.44', 'checked.at advancing within 90 s', ats.map((a) => (Number.isFinite(a) ? new Date(a).toISOString() : 'none')).join(', ') || 'one checked event');
    const storage = await page.evaluate(() => {
      const g = globalThis as unknown as { localStorage: { length: number; key(i: number): string | null; getItem(k: string): string | null }; sessionStorage: { length: number; key(i: number): string | null; getItem(k: string): string | null } };
      const dump = (s: typeof g.localStorage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? '')}`).join('\n');
      return `${dump(g.localStorage)}\n${dump(g.sessionStorage)}`;
    });
    const html = await page.content();
    for (const [where, text] of [['messages', frames.map((f) => f.raw).join('\n')], ['scripts', scripts.join('\n')], ['storage', storage], ['page', html]] as const) {
      check(!TOKEN_PATTERN.test(text), 'R9.44', `no GitHub token in the ${where}`, 'a token pattern was found');
    }
    const snapshots = frames.filter((f) => messageKind(f.data) === 'snapshot');
    const latest = () => [...frames].reverse().find((f) => messageKind(f.data) === 'snapshot')?.data;
    // The last GitHub read of each repository's open Issues, kept for the R9.2 check.
    const onGitHub = new Map<string, Issue[]>();
    const diff = async () => {
      const got = snapshotOpenIssues(latest(), NIBFIN_REPOS);
      const out: string[] = [];
      for (const repo of NIBFIN_REPOS) {
        const issues = await openIssues(ctx.github, `${OWNER}/${repo}`);
        onGitHub.set(repo, issues);
        const want = issues.map((i) => i.number).sort((a, b) => a - b);
        const have = got.get(repo) ?? [];
        if (want.join(',') !== have.join(',')) out.push(`${repo}: Live [${have.join(', ')}] vs GitHub [${want.join(', ')}]`);
      }
      return out;
    };
    let mismatch = await diff();
    if (mismatch.length) {
      const n = frames.length;
      const until = Date.now() + 90_000;
      while (Date.now() < until && !frames.slice(n).some((f) => messageKind(f.data) === 'checked')) await sleep(1000);
      mismatch = await diff();
    }
    check(!mismatch.length, 'R9.44', "each repository's open Issues in the Live snapshot equal GitHub's", mismatch.join('; '));

    // R9.40: read-only repo views of exactly the three repositories.
    const repos = snapshotRepos(snapshots[0]?.data);
    check(repos.join(',') === [...NIBFIN_REPOS].sort().join(','), 'R9.40', `Live data for exactly ${NIBFIN_REPOS.join(', ')}`, repos.join(', ') || 'none');
    const text = await bodyText(page);
    for (const r of NIBFIN_REPOS) check(text.includes(r), 'R9.40', `a repo view of ${r}`, 'not shown');
    const ops = page.getByRole('button', { name: /^(pause|resume|init|upgrade|(runner )?(add|remove)|log ?in)\b/i });
    check((await ops.count()) === 0, 'R9.40', 'no operation controls', `${await ops.count()} controls`);
    check((await page.getByRole('dialog').count()) === 0, 'R9.40', 'no dialog', 'a dialog');
    // R9.2: one Issue element of a shown repository, with its label-only stage track.
    const live = snapshotOpenIssues(latest(), NIBFIN_REPOS);
    const pick = pickTrackIssue(
      NIBFIN_REPOS.map((repo) => ({ repo, issues: onGitHub.get(repo) ?? [], live: live.get(repo) ?? [] })),
      await shownLiveRepo(page),
    );
    if (!pick) throw new Error(noTrackIssueMessage(NIBFIN_REPOS.map((repo) => ({ repo, open: onGitHub.get(repo)?.length ?? 0 }))));
    await showLiveRepo(page, pick.repo);
    let trackIssue = pick.issue;
    let track = await readTrack(page, trackIssue);
    if (track.problem && !track.stepsProblem) {
      // Labels on the live repositories change during the run; re-read once after the next Worker check.
      const n = frames.length;
      const until90 = Date.now() + 90_000;
      while (Date.now() < until90 && !frames.slice(n).some((f) => messageKind(f.data) === 'checked')) await sleep(1000);
      trackIssue = await readIssue(ctx.github, trackIssue.repo, trackIssue.number);
      track = await readTrack(page, trackIssue);
    }
    check(!track.problem, 'R9.2', `the Shape → Deliver → Done track of ${trackIssue.repo}#${trackIssue.number}${stageOf(trackIssue.labels) ? ` at ${stageOf(trackIssue.labels)} (labels only)` : ''}`, () => `${track.problem}; element text: ${quote(track.text)}`);
    const trackNote = `${trackIssue.repo}#${trackIssue.number} track checked${stageOf(trackIssue.labels) ? ` at ${stageOf(trackIssue.labels)}` : ' (no label stage)'}`;

    // R9.11: no Runner or host names in the data.
    const runnerNames = await selfHostedRunnerNames(ctx.github);
    const leaks = frames.flatMap((f) => (f.data === undefined ? [] : liveLeaks(f.data, runnerNames)));
    for (const n of runnerNames) if (text.includes(n)) leaks.push(`Runner name ${n} on the page`);
    check(!leaks.length, 'R9.11', 'no Runner name or host name in Live data', [...new Set(leaks)].join('; '));
    return `Live page: ${frames.length} messages (${checked.length} checked) from ${new URL(sockets[0] as string).host}; three read-only repo views; open Issues match; ${trackNote}; no token, Runner or host names (${runnerNames.length} self-hosted names checked)`;
  },
});
