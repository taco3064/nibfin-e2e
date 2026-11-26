// Proposal R9.23, R9.24, R9.5, R9.8 and R9.34: how the Dashboard keeps its data current.
import type { Page } from 'playwright-core';
import type { RunContext } from '../../src/types.ts';
import { FIXTURE_E, check, fail, fixtureTitle, intervalMatches, startsInWindow } from './checks.ts';
import { assertQuietSandboxes, createIssue, ensureFixtures, findByTitle, me, openIssues, readIssue, sleep, until } from './github.ts';
import type { Issue } from './github.ts';
import {
  bodyText,
  button,
  defineScenario,
  gotoView,
  issueElement,
  openDashboard,
  openPage,
  podmanPs,
  readUpdateMarker,
  sameDocument,
  selectRepo,
  startDashboard,
  watchLocalJobStarts,
} from './support.ts';
import type { Secrets, View } from './support.ts';
import { issueFeatures } from './views.ts';

const PLAIN_LABEL = 'e2e-plain';
/** R9.24 checks every 30–60 s; the tolerance covers the push to the browser and rendering. */
const POLL_MS = 60_000;
const TOLERANCE_MS = 30_000;

/**
 * A manual refresh. The page's own Refresh control when it has one; otherwise a fresh
 * server and page on the same view, since reloading would re-send a spent one-time proof (R9.26).
 */
async function refreshed(ctx: RunContext, secrets: Secrets, page: Page, view: View, repo?: string): Promise<Page> {
  const r = await button(page, /refresh/i);
  if (r) {
    await r.click();
    await sleep(3000);
    return page;
  }
  return freshView(ctx, secrets, view, repo);
}

/** A new server and page opened on a view; both are stopped when the scenario ends. */
async function freshView(ctx: RunContext, secrets: Secrets, view: View, repo?: string): Promise<Page> {
  const dash = await startDashboard(ctx, secrets);
  ctx.defer(() => dash.stop());
  const { page } = await openPage(ctx);
  await openDashboard(page, dash);
  await gotoView(page, view);
  if (repo) await selectRepo(page, repo);
  await sleep(3000);
  return page;
}

/** Checks `seen` at least once and until `ms` passed, without navigating; returns the elapsed ms or undefined. */
async function seenWithin(page: Page, seen: () => Promise<boolean>, ms: number): Promise<number | undefined> {
  const from = Date.now();
  for (;;) {
    if (await seen()) return Date.now() - from;
    if (Date.now() - from > ms) return undefined;
    await sleep(1000);
  }
}

async function remoteChange(ctx: RunContext, secrets: Secrets, markers: Record<string, string>, notes: string[]) {
  const gh = ctx.github;
  const exec = ctx.sandbox.execution;
  const f = await ensureFixtures(gh, ctx.sandbox);
  const dashP = await startDashboard(ctx, secrets);
  const dashR = await startDashboard(ctx, secrets);
  try {
    const person = (await openPage(ctx)).page;
    await openDashboard(person, dashP);
    await gotoView(person, 'person');
    markers.person = await readUpdateMarker(person);
    const repo = (await openPage(ctx)).page;
    await openDashboard(repo, dashR);
    await gotoView(repo, 'repo');
    await selectRepo(repo, exec);
    markers.repo = await readUpdateMarker(repo);

    await gh.rest('POST', `/repos/${exec}/labels`, { name: PLAIN_LABEL, color: 'cccccc', description: 'nibfin-e2e: not a Nibfin label' }, [422]);
    const D = await readIssue(gh, exec, f.D.number);
    check(D.labels.includes('pending'), 'R9.24', 'fixture D to keep pending (so the label event dispatches nothing)', `[${D.labels.join(', ')}]`);
    await gh.rest('POST', `/repos/${exec}/issues/${D.number}/labels`, { labels: [PLAIN_LABEL] });
    let liveSeen = 0;
    for (const [name, page] of [['person', person], ['repo', repo]] as const) {
      const shows = async (p: Page = page) => (await issueElement(p, D.title).innerText().catch(() => '')).includes(PLAIN_LABEL);
      if (markers[name] === 'live') {
        const ms = await seenWithin(page, shows, POLL_MS + TOLERANCE_MS);
        check(ms !== undefined, 'R9.24', `the ${name} view (marked Live) to show D's new label within ${(POLL_MS + TOLERANCE_MS) / 1000} s without navigation`, 'not shown');
        check(await sameDocument(page), 'R9.24', `no reload of the ${name} view`, 'the document was reloaded');
        notes.push(`${name} view showed a label edited on GitHub after ${Math.round((ms as number) / 1000)} s`);
        liveSeen++;
      } else {
        const again = await refreshed(ctx, secrets, page, name, name === 'repo' ? exec : undefined);
        check(await shows(again), 'R9.8', `the ${name} view (marked manual) to show D's new label after a manual refresh`, 'not shown');
        notes.push(`${name} view is manual and showed the label after a refresh`);
      }
    }
    check(liveSeen > 0, 'R9.24', 'the server to push changes made elsewhere to at least one view marked Live', 'neither the person nor the repo view is Live');
  } finally {
    await dashP.stop();
    await dashR.stop();
  }
}

/** The single local Job for fixture E: busy, back to idle, then its timeline interval (R9.23, R9.5). */
async function localJob(ctx: RunContext, secrets: Secrets, markers: Record<string, string>, notes: string[]) {
  const gh = ctx.github;
  const exec = ctx.sandbox.execution;
  const regs = await gh.list<{ name: string; status: string }>(`/repos/${exec}/actions/runners`, 'runners');
  check(regs.filter((r) => r.status === 'online').length >= 2, 'R9.23', 'two online claude Runners before dispatch', regs.map((r) => `${r.name} ${r.status}`).join(', '));
  check(!(await findByTitle(gh, exec, fixtureTitle('E'))), 'R9.23', 'fixture E not yet created in this run', 'it exists already');
  await assertQuietSandboxes({ github: gh, sandboxes: ctx.sandbox, podmanPs: () => podmanPs(ctx), log: ctx.log });

  const watcher = await watchLocalJobStarts(ctx);
  const dashP = await startDashboard(ctx, secrets);
  const dashR = await startDashboard(ctx, secrets);
  let E: Issue | undefined;
  try {
    const person = (await openPage(ctx)).page;
    await openDashboard(person, dashP);
    await gotoView(person, 'person');
    const runner = (await openPage(ctx)).page;
    await openDashboard(runner, dashR);
    await gotoView(runner, 'runner');
    markers.runner = await readUpdateMarker(runner);

    const from = Date.now();
    E = await createIssue(gh, exec, fixtureTitle('E'), FIXTURE_E.labels, await me(gh));
    const first = await until(async () => watcher.starts().filter((s) => s.at >= from - 5000), (s) => s.length > 0, 20 * 60_000, 2000);
    check(first.length, 'R9.23', 'a local Nibfin Job container to start for fixture E', 'no Job container start was seen in 20 min');
    const startedAt = Date.now();
    const issue = E;
    const inProgress = async () => /in progress|running|queued/i.test(`${await issueElement(person, issue.title).innerText().catch(() => '')} ${await issueElement(person, issue.title).locator('[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).join(' ')).catch(() => '')}`);
    const stripMs = await seenWithin(person, inProgress, 20_000);
    check(stripMs !== undefined && (await sameDocument(person)), 'R9.23', "E's run strip to show an in-progress run within 20 s of the Job start, without navigation", 'not shown');
    const busyWithE = async (p: Page = runner) => {
      const t = await bodyText(p);
      return /\bbusy\b/i.test(t) && new RegExp(`#${issue.number}\\b`).test(t) && /\bshape\b/i.test(t) && /\b\d{1,2}:\d{2}\b|\b\d+\s?(s|m|min)\b/.test(t);
    };
    if (markers.runner === 'live') {
      const ms = await seenWithin(runner, busyWithE, 20_000 - (Date.now() - startedAt));
      check(ms !== undefined && (await sameDocument(runner)), 'R9.23', `a Runner busy with ${'#'}${issue.number}, its stage and a time within 20 s, without navigation`, (await bodyText(runner)).slice(0, 300));
    } else {
      const again = await refreshed(ctx, secrets, runner, 'runner');
      check(await busyWithE(again), 'R9.5', `after a refresh, a Runner busy with #${issue.number}, its stage and a time`, (await bodyText(runner)).slice(0, 300));
    }

    // R9.2: the same Issue element in the Runner view while a Runner is busy with it.
    const inRunner = issueElement(runner, issue.title);
    check(await inRunner.count(), 'R9.2', `E's Issue element in the Runner view while busy`, 'only other text');
    const runnerFeatures = await issueFeatures(inRunner, issue);
    const personFeatures = await issueFeatures(issueElement(person, issue.title), issue);
    check(JSON.stringify(runnerFeatures) === JSON.stringify(personFeatures), 'R9.2', 'the same Issue element in the person and Runner views', JSON.stringify({ personFeatures, runnerFeatures }));

    // Back to idle: pause E (no redispatch) and cancel its run.
    await gh.rest('POST', `/repos/${exec}/issues/${issue.number}/labels`, { labels: ['pause'] });
    const runs = await gh.list<{ id: number; display_title: string; status: string }>(`/repos/${exec}/actions/runs?status=in_progress`, 'workflow_runs');
    const mine = runs.filter((r) => new RegExp(`#${issue.number}\\b`).test(r.display_title));
    check(mine.length, 'R9.23', `an in-progress run titled with #${issue.number} (R5.5)`, runs.map((r) => r.display_title).join(' | ') || 'none');
    for (const r of mine) await gh.rest('POST', `/repos/${exec}/actions/runs/${r.id}/cancel`, undefined, [409]);
    const idle = async (p: Page = runner) => !/\bbusy\b/i.test(await bodyText(p));
    if (markers.runner === 'live') {
      const ms = await seenWithin(runner, idle, POLL_MS + TOLERANCE_MS);
      check(ms !== undefined && (await sameDocument(runner)), 'R9.23', 'the Runner back to idle without navigation after the Job ended', 'still busy');
    } else {
      await sleep(POLL_MS);
      const again = await refreshed(ctx, secrets, runner, 'runner');
      check(await idle(again), 'R9.5', 'the Runner idle after a refresh once the Job ended', 'still busy');
    }
    const starts = startsInWindow(watcher.starts(), from - 5000, Date.now());
    if (starts.length !== 1) {
      const open = (await openIssues(gh, exec)).map((i) => `#${i.number} [${i.labels.join(', ')}]`);
      fail('R9.23', 'exactly one local Job start, for fixture E', `${starts.length} starts (${starts.map((s) => new Date(s.at).toISOString()).join(', ')}); open Issues: ${open.join('; ')}`);
    }
    notes.push(`E's Job: run strip in progress after ${Math.round((stripMs as number) / 1000)} s, Runner busy then idle, one local Job`);

    // R9.5 timeline from the job record.
    const job = await until(
      async () => {
        const all: { runner_name: string | null; started_at: string; completed_at: string | null; labels: string[] }[] = [];
        for (const r of mine) all.push(...(await gh.list<(typeof all)[number]>(`/repos/${exec}/actions/runs/${r.id}/jobs`, 'jobs')));
        return all.find((j) => j.runner_name && j.labels.includes('self-hosted'));
      },
      (j) => Boolean(j?.completed_at),
      5 * 60_000,
      5000,
    );
    check(job?.completed_at, 'R9.5', "E's self-hosted job record with completed_at", JSON.stringify(job));
    // A fresh page, so the check does not depend on the update path.
    const timeline = await freshView(ctx, secrets, 'runner');
    const rec = job as { runner_name: string; started_at: string; completed_at: string };
    const row = timeline.locator('li, [role="listitem"], [role="row"], section, article').filter({ hasText: rec.runner_name }).last();
    check(await row.count(), 'R9.5', `a timeline row for Runner ${rec.runner_name}`, 'none');
    const shown = await row.locator('[title], [aria-label]').evaluateAll((els) => els.map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`));
    check(intervalMatches(shown, rec.started_at, rec.completed_at), 'R9.5', `a busy interval ${rec.started_at} – ${rec.completed_at} (±1 min) on ${rec.runner_name}'s 24-hour timeline`, shown.filter((s) => s.trim()).slice(0, 5).join(' | ') || 'an empty timeline');
    notes.push(`timeline shows ${rec.runner_name}'s busy interval`);
  } finally {
    await dashP.stop();
    await dashR.stop();
    await watcher.stop();
  }
}

async function failures(ctx: RunContext, secrets: Secrets, markers: Record<string, string>, notes: string[]) {
  const gh = ctx.github;
  const exec = ctx.sandbox.execution;
  const f = await ensureFixtures(gh, ctx.sandbox);
  const dash = await startDashboard(ctx, secrets);
  let stopped = false;
  try {
    const { page } = await openPage(ctx);
    await openDashboard(page, dash);
    // A failed read.
    await gotoView(page, 'repo');
    await selectRepo(page, 'taco3064/nibfin-e2e-no-such-repository-298');
    await sleep(5000);
    const t = await bodyText(page);
    check(/not found|failed|error|cannot|could not|unable/i.test(t), 'R9.34', 'a failed read of a missing repository marked as a failure', t.slice(0, 300));
    check(!/\b(healthy|all good|up to date)\b/i.test(t), 'R9.34', 'no health shown as fine for an unreadable repository', t.slice(0, 300));

    // A stopped server.
    await gotoView(page, 'person');
    await dash.stop();
    stopped = true;
    await sleep(15_000);
    if (markers.person === 'live') {
      const marker = await readUpdateMarker(page).catch(() => 'neither');
      check(marker !== 'live', 'R9.8', 'the header no longer Live after the server stopped', marker);
    }
    const after = await bodyText(page);
    check(/outdated|stale|offline|disconnected|stopped|reconnect|not updating|lost/i.test(after), 'R9.34', 'the page to say its data may be outdated once updates stopped', after.slice(0, 300));
    const toggle = issueElement(page, f.D.title).getByRole('button', { name: /^(pause|resume)\b/i }).first();
    if ((await toggle.count()) && (await toggle.isEnabled())) {
      await toggle.click();
      await sleep(5000);
      const r = await bodyText(page);
      check(/fail|error|could not|unable|not sent/i.test(r), 'R9.34', 'a pause click without a server shown as a failure', r.slice(0, 300));
    }
    const D = await readIssue(gh, exec, f.D.number);
    check(!D.labels.includes('pause') && D.labels.includes('pending'), 'R9.34', 'D unchanged on GitHub (no pause, still pending)', `[${D.labels.join(', ')}]`);
    await page.clock.install();
    const early = await bodyText(page);
    await page.clock.fastForward('02:00:00');
    await sleep(2000);
    const late = await bodyText(page);
    const STALE = /\b(stale|outdated|out of date|[2-9]\s?h(ours?)?\s+ago|1[0-9]{2}\s?m(in(utes?)?)?\s+ago)\b/i;
    check(late !== early && STALE.test(late) && (late.match(new RegExp(STALE.source, 'gi'))?.length ?? 0) > (early.match(new RegExp(STALE.source, 'gi'))?.length ?? 0), 'R9.34', 'the data marked stale (a stale marker or a two-hour age that was not there before) after the page clock moved two hours', late.slice(0, 300));
    notes.push('a failed read and a stopped server are shown as such, never as success');
  } finally {
    if (!stopped) await dash.stop();
  }
}

export const dashboardUpdates = defineScenario({
  id: 'dashboard-updates',
  rules: ['R9.23', 'R9.24', 'R9.5', 'R9.8', 'R9.34'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    const notes: string[] = [];
    const markers: Record<string, string> = {};
    await remoteChange(ctx, secrets, markers, notes);
    await localJob(ctx, secrets, markers, notes);
    await failures(ctx, secrets, markers, notes);
    notes.unshift(`markers: ${Object.entries(markers).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    return notes.join('; ');
  },
});
