// Proposal R9.23, R9.24, R9.5, R9.8 and R9.34: how the Dashboard keeps its data current.
import type { Page } from 'playwright-core';
import type { RunContext } from '../../src/types.ts';
import {
  FIXTURE_E,
  check,
  describePauseView,
  fail,
  fixtureTitle,
  intervalMatches,
  pauseAppeared,
  pausePreconditionProblem,
  startsInWindow,
} from './checks.ts';
import type { PauseView } from './checks.ts';
import {
  assertQuietSandboxes,
  createIssue,
  ensureFixtures,
  findByTitle,
  me,
  openIssues,
  readIssue,
  sleep,
  until,
} from './github.ts';
import type { Issue } from './github.ts';
import {
  bodyText,
  button,
  portClosed,
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

/** What D's element shows about pause in a view, without navigating (R9.2, R9.19). */
async function pauseView(p: Page, title: string): Promise<PauseView> {
  const missing: PauseView = { present: false, text: '', pauseControls: 0, resumeControls: 0 };
  const el = issueElement(p, title);
  if (!(await el.count().catch(() => 0))) return missing;
  const text = await el.innerText().catch(() => undefined);
  if (text === undefined) return missing;
  const count = (name: RegExp) =>
    el
      .getByRole('button', { name })
      .count()
      .catch(() => 0);
  return { present: true, text, pauseControls: await count(/^pause\b/i), resumeControls: await count(/^resume\b/i) };
}

/** Removes the pause added to D and reads D back, so later steps find it with pending and without pause (R9.34). */
async function unpauseD(ctx: RunContext, exec: string, number: number): Promise<void> {
  const gh = ctx.github;
  await gh.rest('DELETE', `/repos/${exec}/issues/${number}/labels/pause`, undefined, [404]);
  const D = await until(
    () => readIssue(gh, exec, number),
    (i) => !i.labels.includes('pause'),
    60_000,
    2000,
  );
  if (D.labels.includes('pause') || !D.labels.includes('pending'))
    throw new Error(`harness: fixture D (#${number}) still has [${D.labels.join(', ')}] after removing pause`);
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
    const views = [
      ['person', person],
      ['repo', repo],
    ] as const;

    // D must be listed with a Pause or Resume control and no pause marker before the edit. As a
    // pending Issue it may offer only Resume (R9.55, R5.51), so the edit can only show up as a
    // new pause marker or a Resume control it did not have before.
    const before: Record<string, PauseView> = {};
    for (const [name, page] of views) {
      const v = await until(
        () => pauseView(page, f.D.title),
        (x) => pausePreconditionProblem(x) === undefined,
        POLL_MS + TOLERANCE_MS,
        2000,
      );
      const problem = pausePreconditionProblem(v);
      if (problem !== undefined) {
        throw new Error(
          `precondition: fixture D is not ready for the edit in the ${name} view (${problem}; saw: ${describePauseView(v)}); nothing was edited and nothing is asserted about R9.24`,
        );
      }
      before[name] = v;
    }

    const D = await readIssue(gh, exec, f.D.number);
    check(
      D.labels.includes('pending'),
      'R9.24',
      'fixture D to keep pending (so the label event dispatches nothing)',
      `[${D.labels.join(', ')}]`,
    );
    let pauseAdded = false;
    let failed = false;
    let error: unknown;
    try {
      pauseAdded = true;
      await gh.rest('POST', `/repos/${exec}/issues/${D.number}/labels`, { labels: ['pause'] });
      // Every view's window starts at the edit, not when its own check starts.
      const changedAt = Date.now();
      let liveSeen = 0;
      for (const [name, page] of views) {
        const shown = (after: PauseView) =>
          `before the edit: ${describePauseView(before[name] as PauseView)}; after: ${describePauseView(after)}`;
        if (markers[name] === 'live') {
          const ms = await seenWithin(
            page,
            async () => pauseAppeared(before[name] as PauseView, await pauseView(page, D.title)),
            Math.max(0, POLL_MS + TOLERANCE_MS - (Date.now() - changedAt)),
          );
          if (ms === undefined) {
            const after = await pauseView(page, D.title);
            fail(
              'R9.24',
              `the ${name} view (marked Live) to show D's pause (added on GitHub) within ${(POLL_MS + TOLERANCE_MS) / 1000} s of the edit, without navigation`,
              `not shown; ${shown(after)}`,
            );
          }
          check(await sameDocument(page), 'R9.24', `no reload of the ${name} view`, 'the document was reloaded');
          notes.push(
            `${name} view showed a pause added on GitHub ${Math.round((Date.now() - changedAt) / 1000)} s after the edit`,
          );
          liveSeen++;
        } else {
          const again = await refreshed(ctx, secrets, page, name, name === 'repo' ? exec : undefined);
          const after = await pauseView(again, D.title);
          check(
            pauseAppeared(before[name] as PauseView, after),
            'R9.8',
            `the ${name} view (marked manual) to show D's pause after a manual refresh`,
            () => `not shown; ${shown(after)}`,
          );
          notes.push(`${name} view is manual and showed the pause after a refresh`);
        }
      }
      check(
        liveSeen > 0,
        'R9.24',
        'the server to push changes made elsewhere to at least one view marked Live',
        'neither the person nor the repo view is Live',
      );
    } catch (e) {
      failed = true;
      error = e;
    }
    // Always remove the pause again; an earlier failure keeps its own message and a
    // clean-up failure is then only logged.
    if (pauseAdded) {
      try {
        await unpauseD(ctx, exec, D.number);
      } catch (e) {
        if (!failed) {
          failed = true;
          error = e;
        } else {
          ctx.log(`removing pause from fixture D failed: ${(e as Error).message}`);
        }
      }
    }
    if (failed) throw error;
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
  if (regs.filter((r) => r.status === 'online').length < 2) {
    throw new Error(
      `precondition: two online claude Runners are needed before dispatch, found ${regs.map((r) => `${r.name} ${r.status}`).join(', ') || 'none'}; nothing was created and nothing is asserted about the product`,
    );
  }
  if (await findByTitle(gh, exec, fixtureTitle('E')))
    throw new Error(
      'precondition: fixture E already exists in this run; nothing was created and nothing is asserted about the product',
    );
  await assertQuietSandboxes({ github: gh, sandboxes: ctx.sandbox, podmanPs: () => podmanPs(ctx), log: ctx.log });

  const watcher = await watchLocalJobStarts(ctx);
  const dashP = await startDashboard(ctx, secrets);
  const dashR = await startDashboard(ctx, secrets);
  let E: Issue | undefined;
  let settled = false;
  try {
    // The run strip is read in the execution repo view, which lists every open Issue
    // without native search (R5.49), so E can appear there without the search index lag.
    const person = (await openPage(ctx)).page;
    await openDashboard(person, dashP);
    await gotoView(person, 'repo');
    await selectRepo(person, exec);
    const runner = (await openPage(ctx)).page;
    await openDashboard(runner, dashR);
    await gotoView(runner, 'runner');
    markers.runner = await readUpdateMarker(runner);

    const from = Date.now();
    E = await createIssue(gh, exec, fixtureTitle('E'), FIXTURE_E.labels, await me(gh));
    const first = await until(
      async () => watcher.starts().filter((s) => s.at >= from - 5000),
      (s) => s.length > 0,
      20 * 60_000,
      2000,
    );
    check(
      first.length,
      'R9.23',
      'a local Nibfin Job container to start for fixture E',
      'no Job container start was seen in 20 min',
    );
    const jobStart = Math.min(Date.now(), (first[0] as { at: number }).at);
    const issue = E;
    // Only a Runner row that holds #E: other rows, legends and E's own track may say "busy" or "Shape".
    const busyWithE = async (p: Page = runner) => {
      const row = p
        .locator('li, [role="row"], [role="listitem"], article')
        .filter({ hasText: new RegExp(`#${issue.number}\\b`) })
        .filter({ hasText: /\bbusy\b/i })
        .last();
      if (!(await row.count())) return false;
      const t = (await row.innerText()).replace(/\s+/g, ' ');
      const stage =
        (await row
          .locator('[aria-current="step"], [aria-current="true"]')
          .first()
          .innerText()
          .catch(() => '')) || t;
      return /\bshape\b/i.test(stage) && /\b\d{1,2}:\d{2}\b|\b\d+\s?(s|m|min)\b/.test(t);
    };
    // A live Runner view learns of the Job from podman events (R9.23), so its 20 s count from
    // the container start alone; it is watched while the repo view waits for E to be listed.
    const runnerBusy =
      markers.runner === 'live'
        ? seenWithin(runner, busyWithE, Math.max(0, jobStart + 20_000 - Date.now())).catch(() => undefined)
        : Promise.resolve(undefined);
    // E reaches the repo view through GitHub (R9.24); its strip counts 20 s from the later
    // of the Job start and E's first appearance, since an unlisted Issue cannot show a strip.
    const listed = await seenWithin(
      person,
      async () => (await issueElement(person, issue.title).count()) > 0,
      POLL_MS + TOLERANCE_MS,
    );
    check(
      listed !== undefined,
      'R9.24',
      `E listed in the repo view within ${(POLL_MS + TOLERANCE_MS) / 1000} s`,
      'not listed',
    );
    // seenWithin returns as soon as E is seen, so now is E's first appearance.
    const startedAt = Math.max(jobStart, Date.now());
    const inProgress = async () =>
      /in progress|running|queued/i.test(
        `${await issueElement(person, issue.title)
          .innerText()
          .catch(() => '')} ${await issueElement(person, issue.title)
          .locator('[aria-label]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).join(' '))
          .catch(() => '')}`,
      );
    const stripMs = await seenWithin(person, inProgress, Math.max(0, 20_000 - (Date.now() - startedAt)));
    check(
      stripMs !== undefined && (await sameDocument(person)),
      'R9.23',
      "E's run strip to show an in-progress run within 20 s of the Job start (or of E's first appearance, if later), without navigation",
      'not shown',
    );
    // The page the Runner view is read on: the live page, or a manually refreshed one.
    let runnerPage = runner;
    if (markers.runner === 'live') {
      const ms = await runnerBusy;
      check(
        ms !== undefined && (await sameDocument(runner)),
        'R9.23',
        `a Runner busy with #${issue.number}, its stage and a time within 20 s of the Job container start, without navigation`,
        (await bodyText(runner)).slice(0, 300),
      );
    } else {
      runnerPage = await refreshed(ctx, secrets, runner, 'runner');
      check(
        await busyWithE(runnerPage),
        'R9.5',
        `after a refresh, a Runner busy with #${issue.number}, its stage and a time`,
        (await bodyText(runnerPage)).slice(0, 300),
      );
    }

    // R9.2: the same Issue element in the Runner view while a Runner is busy with it.
    const inRunner = issueElement(runnerPage, issue.title);
    check(await inRunner.count(), 'R9.2', `E's Issue element in the Runner view while busy`, 'only other text');
    const runnerFeatures = await issueFeatures(inRunner, issue);
    const personFeatures = await issueFeatures(issueElement(person, issue.title), issue);
    check(
      JSON.stringify(runnerFeatures) === JSON.stringify(personFeatures),
      'R9.2',
      'the same Issue element in the repo and Runner views',
      JSON.stringify({ repoFeatures: personFeatures, runnerFeatures }),
    );

    // Back to idle: find E's run with a self-hosted job, pause E (no redispatch) and cancel that one run.
    const runs = await gh.list<{ id: number; display_title: string; status: string }>(
      `/repos/${exec}/actions/runs?status=in_progress`,
      'workflow_runs',
    );
    const titled = runs.filter((r) => new RegExp(`#${issue.number}\\b`).test(r.display_title));
    const mine: typeof titled = [];
    let busyRunner = '';
    for (const r of titled) {
      const jobs = await gh.list<{ labels: string[]; runner_name: string | null }>(
        `/repos/${exec}/actions/runs/${r.id}/jobs`,
        'jobs',
      );
      const hosted = jobs.find((j) => j.labels.includes('self-hosted'));
      if (!hosted) continue;
      mine.push(r);
      busyRunner ||= hosted.runner_name ?? '';
    }
    check(
      mine.length === 1,
      'R9.23',
      `one in-progress run titled with #${issue.number} (R5.5) with a self-hosted job`,
      runs.map((r) => `${r.id} ${r.display_title}`).join(' | ') || 'none',
    );
    check(busyRunner, 'R9.23', `the self-hosted job of #${issue.number} to name its Runner`, 'no runner_name yet');
    await gh.rest('POST', `/repos/${exec}/issues/${issue.number}/labels`, { labels: ['pause'] });
    await gh.rest('POST', `/repos/${exec}/actions/runs/${(mine[0] as { id: number }).id}/cancel`, undefined, [409]);
    settled = true;
    // Only the row of the Runner that ran E: other rows, legends and the timeline may say "busy".
    const idle = async (p: Page = runner) => {
      const row = (
        await p
          .locator('li, [role="listitem"], [role="row"], article, section')
          .filter({ hasText: busyRunner })
          .last()
          .innerText()
          .catch(() => '')
      ).replace(/\s+/g, ' ');
      return /\bidle\b/i.test(row) && !new RegExp(`#${issue.number}\\b`).test(row);
    };
    if (markers.runner === 'live') {
      const ms = await seenWithin(runner, idle, POLL_MS + TOLERANCE_MS);
      check(
        ms !== undefined && (await sameDocument(runner)),
        'R9.23',
        `Runner ${busyRunner} back to idle without navigation after the Job ended`,
        'still busy or not shown',
      );
    } else {
      await sleep(POLL_MS);
      const again = await refreshed(ctx, secrets, runner, 'runner');
      check(
        await idle(again),
        'R9.5',
        `Runner ${busyRunner} idle after a refresh once the Job ended`,
        'still busy or not shown',
      );
    }
    const starts = startsInWindow(watcher.starts(), from - 5000, Date.now());
    if (starts.length !== 1) {
      const open = (await openIssues(gh, exec)).map((i) => `#${i.number} [${i.labels.join(', ')}]`);
      fail(
        'R9.23',
        'exactly one local Job start, for fixture E',
        `${starts.length} starts (${starts.map((s) => new Date(s.at).toISOString()).join(', ')}); open Issues: ${open.join('; ')}`,
      );
    }
    notes.push(
      `E's Job: run strip in progress after ${Math.round((stripMs as number) / 1000)} s, Runner busy then idle, one local Job`,
    );

    // R9.5 timeline from the job record.
    const job = await until(
      async () => {
        const all: { runner_name: string | null; started_at: string; completed_at: string | null; labels: string[] }[] =
          [];
        for (const r of mine)
          all.push(...(await gh.list<(typeof all)[number]>(`/repos/${exec}/actions/runs/${r.id}/jobs`, 'jobs')));
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
    const row = timeline
      .locator('li, [role="listitem"], [role="row"], section, article')
      .filter({ hasText: rec.runner_name })
      .last();
    check(await row.count(), 'R9.5', `a timeline row for Runner ${rec.runner_name}`, 'none');
    const shown = await row
      .locator('[title], [aria-label]')
      .evaluateAll((els) => els.map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`));
    check(
      intervalMatches(shown, rec.started_at, rec.completed_at),
      'R9.5',
      `a busy interval ${rec.started_at} – ${rec.completed_at} (±1 min) on ${rec.runner_name}'s 24-hour timeline`,
      shown
        .filter((s) => s.trim())
        .slice(0, 5)
        .join(' | ') || 'an empty timeline',
    );
    notes.push(`timeline shows ${rec.runner_name}'s busy interval`);
  } finally {
    await dashP.stop();
    await dashR.stop();
    await watcher.stop();
    if (E && !settled) await settleE(ctx, E).catch((e: Error) => ctx.log(`settling fixture E failed: ${e.message}`));
  }
}

/** After a failure before E was paused: pause E and cancel its runs that hold a local Runner, so no Job outlives the scenario. */
async function settleE(ctx: RunContext, E: Issue): Promise<void> {
  const gh = ctx.github;
  const exec = ctx.sandbox.execution;
  const now = await readIssue(gh, exec, E.number);
  if (!now.labels.includes('pause'))
    await gh.rest('POST', `/repos/${exec}/issues/${E.number}/labels`, { labels: ['pause'] });
  for (const status of ['queued', 'in_progress']) {
    const runs = await gh.list<{ id: number; display_title: string }>(
      `/repos/${exec}/actions/runs?status=${status}`,
      'workflow_runs',
    );
    for (const r of runs.filter((x) => new RegExp(`#${E.number}\\b`).test(x.display_title))) {
      const jobs = await gh.list<{ labels: string[] }>(`/repos/${exec}/actions/runs/${r.id}/jobs`, 'jobs');
      if (jobs.some((j) => j.labels.includes('self-hosted')) || status === 'queued')
        await gh.rest('POST', `/repos/${exec}/actions/runs/${r.id}/cancel`, undefined, [409]);
    }
  }
  ctx.log(`fixture E (#${E.number}) paused and its runs cancelled after the scenario stopped early`);
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
    check(
      /not found|failed|error|cannot|could not|unable/i.test(t),
      'R9.34',
      'a failed read of a missing repository marked as a failure',
      t.slice(0, 300),
    );
    check(
      !/\b(healthy|all good|up to date)\b/i.test(t),
      'R9.34',
      'no health shown as fine for an unreadable repository',
      t.slice(0, 300),
    );

    // A stopped server.
    await gotoView(page, 'person');
    await dash.stop();
    stopped = true;
    // Only with nothing left on the port is a click guaranteed to reach no server.
    if (!(await portClosed(dash.port)))
      throw new Error(
        `harness: the Dashboard on 127.0.0.1:${dash.port} still accepts connections after it was stopped; nothing was clicked`,
      );
    await sleep(15_000);
    if (markers.person === 'live') {
      const marker = await readUpdateMarker(page).catch(() => 'neither');
      check(marker !== 'live', 'R9.8', 'the header no longer Live after the server stopped', marker);
    }
    const after = await bodyText(page);
    check(
      /outdated|stale|offline|disconnected|stopped|reconnect|not updating|lost/i.test(after),
      'R9.34',
      'the page to say its data may be outdated once updates stopped',
      after.slice(0, 300),
    );
    // D offers Pause or Resume (R9.19); as a pending Issue it offers Resume (R9.55). Either way
    // the click goes to no server, so it must fail and leave D unchanged on GitHub.
    const control = issueElement(page, f.D.title)
      .getByRole('button', { name: /^(pause|resume)\b/i })
      .first();
    check(await control.count(), 'R9.34', 'a Pause or Resume control on D to try without a server', 'none');
    // The locator matched the accessible name; a text-less button carries it in aria-label.
    const label =
      (await control.innerText().catch(() => '')) || (await control.getAttribute('aria-label').catch(() => '')) || '';
    const controlName = /^\s*resume/i.test(label) ? 'Resume' : 'Pause';
    if (await control.isEnabled()) {
      await control.click();
      await sleep(5000);
      const r = await bodyText(page);
      check(
        /fail|error|could not|unable|not sent/i.test(r),
        'R9.34',
        `a ${controlName} click without a server shown as a failure`,
        r.slice(0, 300),
      );
      check(
        !/\b(paused|resumed|success|succeeded|sent)\b/i.test(
          (await issueElement(page, f.D.title).innerText()).replace(/not sent/gi, ''),
        ),
        'R9.34',
        'no success shown on D',
        'D shows success',
      );
    } else {
      notes.push(`without a server, ${controlName} on D is disabled (not success)`);
    }
    const D = await readIssue(gh, exec, f.D.number);
    check(
      !D.labels.includes('pause') && D.labels.includes('pending'),
      'R9.34',
      'D unchanged on GitHub (no pause, still pending)',
      `[${D.labels.join(', ')}]`,
    );
    await page.clock.install();
    const early = await bodyText(page);
    await page.clock.fastForward('02:00:00');
    await sleep(2000);
    const late = await bodyText(page);
    const STALE = /\b(stale|outdated|out of date|[2-9]\s?h(ours?)?\s+ago|1[0-9]{2}\s?m(in(utes?)?)?\s+ago)\b/i;
    check(
      late !== early &&
        STALE.test(late) &&
        (late.match(new RegExp(STALE.source, 'gi'))?.length ?? 0) >
          (early.match(new RegExp(STALE.source, 'gi'))?.length ?? 0),
      'R9.34',
      'the data marked stale (a stale marker or a two-hour age that was not there before) after the page clock moved two hours',
      late.slice(0, 300),
    );
    notes.push('a failed read and a stopped server are shown as such, never as success');
  } finally {
    if (!stopped) await dash.stop();
  }
}

export const dashboardUpdates = defineScenario({
  id: 'dashboard-updates',
  rules: ['R9.23', 'R9.24', 'R9.5', 'R9.8', 'R9.34', 'R9.2'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    const notes: string[] = [];
    const markers: Record<string, string> = {};
    await remoteChange(ctx, secrets, markers, notes);
    await localJob(ctx, secrets, markers, notes);
    await failures(ctx, secrets, markers, notes);
    notes.unshift(
      `markers: ${Object.entries(markers)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
    return notes.join('; ');
  },
});
