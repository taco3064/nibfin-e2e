// Proposal R9.12, R9.13, R9.18, R9.20–R9.22 and R9.6: operations through the Dashboard.
import type { Locator, Page } from 'playwright-core';
import type { RunContext } from '../../src/types.ts';
import { check, commandInputs, fail, fieldProblems, pauseResumePreconditions, startsInWindow } from './checks.ts';
import type { SchemaInput } from './checks.ts';
import { assertQuietSandboxes, blockedBy, ensureFixtures, readIssue, sleep, until } from './github.ts';
import type { Fixtures } from './github.ts';
import {
  activeView,
  bodyText,
  button,
  closeDialog,
  defineScenario,
  dialog,
  dialogFields,
  gotoView,
  issueElement,
  mustButton,
  openDashboard,
  openPage,
  podmanPs,
  selectRepo,
  startDashboard,
  watchLocalJobStarts,
} from './support.ts';
import type { Secrets } from './support.ts';

/** A small public repository outside the sandboxes where the gate account has less than triage. */
export const READ_ONLY_REPO = 'octocat/Hello-World';

const PREVIEW = /^(preview|next|continue|plan|check)\b/i;

/** Open dialogs only, so controls elsewhere on the page (for example run strips) never count as a confirm step. */
const openDialogs = (page: Page) => page.getByRole('dialog').or(page.getByRole('alertdialog'));
const CONFIRM = /^(confirm|apply|run|yes|proceed)\b/i;

/** Sets a dialog field by its label: a select, a combobox, a checkbox or a text field. */
export async function setField(d: Locator, label: RegExp, value: string | boolean): Promise<void> {
  const f = d.getByLabel(label).first();
  if (!(await f.count())) throw new Error(`the dialog has no field labelled ${label}`);
  if (typeof value === 'boolean') return f.setChecked(value);
  const tag = await f.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    await f.selectOption({ label: value }).catch(() => f.selectOption(value));
    return;
  }
  const role = await f.getAttribute('role');
  if (role === 'combobox' || tag === 'button') {
    await f.click();
    await d.page().getByRole('option', { name: new RegExp(`^\\s*${value}\\s*$`, 'i') }).first().click();
    return;
  }
  await f.fill(value);
}

/** Preview → confirm → progress → read-back; returns the dialog's final text (Proposal R9.21, R9.22). */
export async function confirmedRun(page: Page, d: Locator, rule: string, what: string): Promise<string> {
  await (await mustButton(d, PREVIEW, rule, `the ${what} dialog`)).click();
  const confirm = d.getByRole('button', { name: CONFIRM }).first();
  await confirm.waitFor({ state: 'visible', timeout: 180_000 }).catch(() => fail(rule, `a confirm step in ${what}`, 'none after the preview'));
  const preview = await d.innerText();
  check(/→|->/.test(preview), 'R9.21', `the ${what} preview to show current → next per item`, preview.slice(0, 300));
  await confirm.click();
  const end = Date.now() + 15 * 60_000;
  let text: string;
  for (;;) {
    text = await d.innerText().catch(() => '');
    if (/not confirmed|unconfirmed/i.test(text)) fail('R9.22', `every ${what} item confirmed by read-back`, text.slice(-400));
    if (/\b(read.?back|confirmed|verified)\b/i.test(text) && !/\b(applying|in progress)\b/i.test(text)) break;
    if (/\b[a-z]+(?:_[a-z]+)+\b/.test(text) && /\b(failed|error)\b/i.test(text)) fail(rule, `${what} to apply`, text.slice(-400));
    if (Date.now() > end) fail(rule, `${what} to reach the read-back step`, text.slice(-400));
    await sleep(1000);
  }
  return text;
}

async function commandSchema(ctx: RunContext, secrets: Secrets): Promise<Map<string, SchemaInput[]>> {
  const dash = await startDashboard(ctx, secrets);
  try {
    const { page, api } = await openPage(ctx);
    await openDashboard(page, dash);
    const end = Date.now() + 20_000;
    while (!api.has('/api/commands') && Date.now() < end) await sleep(300);
    const json = api.get('/api/commands');
    if (json === undefined) fail('R9.13', 'the page to read /api/commands', 'no such response');
    return commandInputs(json);
  } finally {
    await dash.stop();
  }
}

/** Opens each operation's dialog and compares its fields with the schema (R9.12, R9.13). */
async function commandDialogs(page: Page, ctx: RunContext, schema: Map<string, SchemaInput[]>, notes: string[]) {
  const problems: string[] = [];
  const open = async (view: 'runner' | 'repo', name: RegExp, command: string) => {
    await gotoView(page, view);
    if (view === 'repo') await selectRepo(page, ctx.sandbox.execution);
    await (await mustButton(page, name, 'R9.12', `the ${view} view`)).click();
    const d = await dialog(page);
    const inputs = schema.get(command);
    if (!inputs) problems.push(`${command}: not in /api/commands`);
    else problems.push(...fieldProblems(command, inputs, await dialogFields(d)));
    await closeDialog(page);
  };
  await open('runner', /^(runner )?add\b/i, 'runner add');
  await open('runner', /^(runner )?remove\b/i, 'runner remove');
  await open('runner', /^log ?in\b/i, 'login');
  await open('repo', /^init\b/i, 'init');
  await open('repo', /^upgrade\b/i, 'upgrade');
  for (const c of ['pause', 'resume', 'status']) if (!schema.has(c)) problems.push(`${c}: not in /api/commands`);
  check(await button(page, /refresh/i), 'R9.12', 'a Refresh control for status', 'none');
  check(!problems.length, 'R9.13', 'every dialog to list exactly the inputs of its command schema', problems.join('; '));
  notes.push('every §5 command is offered; dialog fields match /api/commands');
}

/** R9.6: planning progress with elapsed time and cancel; the CLI preview has no progress lines. */
async function planningProgress(page: Page, ctx: RunContext, notes: string[]) {
  await gotoView(page, 'repo');
  await selectRepo(page, ctx.sandbox.execution);
  await (await mustButton(page, /^init\b/i, 'R9.6', 'the repo view')).click();
  let d = await dialog(page);
  await (await mustButton(d, PREVIEW, 'R9.6', 'the init dialog')).click();
  let sawElapsed = false;
  let sawResult = false;
  let last = '';
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const t = await d.innerText().catch(() => '');
    last = t;
    const planning = Boolean(await button(d, /^cancel\b/i)) && !(await d.getByRole('button', { name: CONFIRM }).count());
    if (planning && /\b\d+(?:\.\d+)?\s?s\b|\b\d+:\d{2}\b/.test(t)) sawElapsed = true;
    // A checked item with its result next to the one still being checked.
    if (planning && sawElapsed && /no change needed|→|->|✓|✔|\b(ok|done|checked|passed)\b/i.test(t)) sawResult = true;
    if (sawElapsed && sawResult) break;
    if (!planning && (await d.getByRole('button', { name: CONFIRM }).count())) break;
    await sleep(100);
  }
  check(sawElapsed, 'R9.6', 'the item being checked to show an elapsed time during planning', 'planning ended without one');
  check(sawResult, 'R9.6', 'checked items listed with their results while planning goes on', last.slice(0, 300));
  await (await mustButton(d, /^cancel\b/i, 'R9.6', 'the planning step')).click();
  await sleep(3000);
  const confirmAfter = await openDialogs(page).getByRole('button', { name: CONFIRM }).filter({ visible: true }).count();
  check(confirmAfter === 0, 'R9.6', 'no confirm step after cancelling planning', 'a confirm button appeared');
  await closeDialog(page);

  const cli = await ctx.ghNibfin(['init']);
  const progress = `${cli.stdout}\n${cli.stderr}`.split('\n').filter((l) => /\belapsed\b|\(\d+(?:\.\d+)?s\)|\bchecking\b.*\d+(?:\.\d+)?s/i.test(l));
  check(!progress.length, 'R9.6', 'the CLI preview of init without --yes to have no planning-progress lines', progress.slice(0, 3).join(' | '));

  await (await mustButton(page, /^init\b/i, 'R9.6', 'the repo view')).click();
  d = await dialog(page);
  await (await mustButton(d, PREVIEW, 'R9.6', 'the init dialog')).click();
  await d.getByRole('button', { name: CONFIRM }).first().waitFor({ state: 'visible', timeout: 180_000 });
  const preview = await d.innerText();
  check(/→|->/.test(preview), 'R9.21', 'each preview item as current → next', preview.slice(0, 300));
  check(/no change needed/i.test(preview), 'R9.21', 'items already in place marked No change needed', preview.slice(0, 300));
  await closeDialog(page);
  notes.push('init planning shows progress and cancels; preview shows current → next and No change needed');
}

/** The read-only repository must be below triage for the account (and have an open Issue); otherwise a precondition, not a product failure. */
async function readOnlyPrecondition(ctx: RunContext, opts: { openIssue?: boolean } = {}): Promise<void> {
  const { data } = await ctx.github.rest<{ permissions?: Record<string, boolean>; open_issues_count: number }>('GET', `/repos/${READ_ONLY_REPO}`);
  const p = data.permissions;
  if (!p || p.admin || p.maintain || p.push || p.triage) throw new Error(`precondition: GitHub does not report the account below triage on ${READ_ONLY_REPO} (permissions ${JSON.stringify(p)}); nothing is asserted about the product`);
  if (opts.openIssue && !(data.open_issues_count > 0)) throw new Error(`precondition: ${READ_ONLY_REPO} has no open Issue; nothing is asserted about the product`);
}

/** R9.21, R9.22 failure: a plan on a repository the account cannot administer shows a code and a next step. */
async function failedPlan(page: Page, ctx: RunContext, notes: string[]) {
  await readOnlyPrecondition(ctx);
  await gotoView(page, 'repo');
  await selectRepo(page, READ_ONLY_REPO);
  await (await mustButton(page, /^init\b/i, 'R9.21', 'the repo view')).click();
  const d = await dialog(page);
  await (await mustButton(d, PREVIEW, 'R9.21', 'the init dialog')).click();
  const text = await until(() => d.innerText(), (t) => /\b[a-z]+(?:_[a-z]+)+\b/.test(t) || /\bfail|error\b/i.test(t), 120_000, 1000);
  check(/\b[a-z]+(?:_[a-z]+)+\b/.test(text), 'R9.21', 'a failure to show its reason code', text.slice(0, 300));
  check(/next step|try|run |ask|need|grant|permission/i.test(text), 'R9.21', 'a failure to show the next step', text.slice(0, 300));
  check(!(await d.getByRole('button', { name: CONFIRM }).count()) && !/\b(success|succeeded|applied)\b/i.test(text), 'R9.21', 'no success or confirm step after a failure', text.slice(0, 300));
  await closeDialog(page);
  notes.push(`init on ${READ_ONLY_REPO} fails with a code and next step`);
}

async function runnerCycle(ctx: RunContext, secrets: Secrets, notes: string[]) {
  const regs = () => ctx.github.list<{ name: string; status: string }>(`/repos/${ctx.sandbox.execution}/actions/runners`, 'runners');
  try {
    await runnerCycleSteps(ctx, secrets, regs, notes);
  } finally {
    // Keep the run's end state (two online claude Runners) for later scenarios even when a step failed.
    const online = (await regs()).filter((r) => r.status === 'online').length;
    if (online < 2) {
      ctx.log(`restoring claude Runners through the CLI (${online} online)`);
      await ctx.ghNibfin(['runner', 'add', 'claude', '--count', String(2 - online), '--yes']);
    }
  }
}

async function runnerCycleSteps(ctx: RunContext, secrets: Secrets, regs: () => Promise<{ name: string; status: string }[]>, notes: string[]) {
  const before = await regs();
  let dash = await startDashboard(ctx, secrets);
  try {
    const { page } = await openPage(ctx);
    await openDashboard(page, dash);
    await gotoView(page, 'runner');
    await (await mustButton(page, /^(runner )?remove\b/i, 'R9.21', 'the Runner view')).click();
    const d = await dialog(page);
    await setField(d, /provider/i, 'claude');
    const del = d.getByLabel(/delete.?login/i);
    if (await del.count()) await del.first().setChecked(false);
    await confirmedRun(page, d, 'R9.21', 'runner remove');
    const after = await until(regs, (x) => !x.some((r) => before.some((b) => b.name === r.name)), 120_000);
    check(!after.some((r) => before.some((b) => b.name === r.name)), 'R9.22', 'the removed Runners gone from GitHub', after.map((r) => r.name).join(', '));
  } finally {
    await dash.stop();
  }

  dash = await startDashboard(ctx, secrets);
  try {
    const { page } = await openPage(ctx);
    await openDashboard(page, dash);
    check((await activeView(page)) === 'runner', 'R9.18', 'the Runner view first when the host has no Runner', String(await activeView(page)));
    const t = await bodyText(page);
    check(/runner add/i.test(t) && /\binit\b/i.test(t), 'R9.18', 'a runner add → init guide', t.slice(0, 300));
    await (await mustButton(page, /^(runner )?add\b/i, 'R9.21', 'the Runner view')).click();
    const d = await dialog(page);
    await setField(d, /provider/i, 'claude');
    await setField(d, /count/i, '2');
    await confirmedRun(page, d, 'R9.21', 'runner add');
    const online = await until(regs, (x) => x.filter((r) => r.status === 'online').length >= 2, 180_000);
    check(online.filter((r) => r.status === 'online').length === 2, 'R9.22', 'two online Runner registrations after runner add', online.map((r) => `${r.name} ${r.status}`).join(', '));
  } finally {
    await dash.stop();
  }

  dash = await startDashboard(ctx, secrets);
  try {
    const { page } = await openPage(ctx);
    await openDashboard(page, dash);
    check((await activeView(page)) === 'person', 'R9.18', 'the person view first when the host has Runners', String(await activeView(page)));
  } finally {
    await dash.stop();
  }
  notes.push('runner remove and add went through preview, confirm, progress and read-back; entry view follows the Runners');
}

/** R9.20: resume and pause F without confirmation; disabled below triage. */
async function pauseResume(ctx: RunContext, secrets: Secrets, f: Fixtures, notes: string[]) {
  const gh = ctx.github;
  await assertQuietSandboxes({ github: gh, sandboxes: ctx.sandbox, podmanPs: () => podmanPs(ctx), log: ctx.log });
  const F = await readIssue(gh, f.F.repo, f.F.number);
  const A = await readIssue(gh, f.A.repo, f.A.number);
  const pre = pauseResumePreconditions(F, A, await blockedBy(gh, F));
  if (pre.length) throw new Error(`precondition for R9.20 on fixture F: ${pre.join('; ')}; nothing was changed`);

  const watcher = await watchLocalJobStarts(ctx);
  const dash = await startDashboard(ctx, secrets);
  try {
    const { page } = await openPage(ctx);
    await openDashboard(page, dash);
    await gotoView(page, 'person');
    const from = Date.now();
    const el = issueElement(page, F.title);
    await el.getByRole('button', { name: /^resume\b/i }).first().waitFor({ state: 'visible', timeout: 90_000 }).catch(() => {});
    await (await mustButton(el, /^resume\b/i, 'R9.20', 'fixture F')).click();
    await sleep(1500);
    check(!(await openDialogs(page).getByRole('button', { name: CONFIRM }).filter({ visible: true }).count()), 'R9.21', 'resume without a confirmation step', 'a confirm button appeared');
    const resumed = await until(() => readIssue(gh, F.repo, F.number), (i) => !i.labels.includes('pause') && !i.labels.includes('pending'), 60_000, 2000);
    check(!resumed.labels.includes('pause') && !resumed.labels.includes('pending'), 'R9.20', 'resume to remove pause and pending on GitHub', `[${resumed.labels.join(', ')}]`);
    await page.waitForTimeout(3000);
    await (await mustButton(issueElement(page, F.title), /^pause\b/i, 'R9.20', 'fixture F after resume')).click();
    await sleep(1500);
    check(!(await openDialogs(page).getByRole('button', { name: CONFIRM }).filter({ visible: true }).count()), 'R9.21', 'pause without a confirmation step', 'a confirm button appeared');
    const paused = await until(() => readIssue(gh, F.repo, F.number), (i) => i.labels.includes('pause'), 60_000, 2000);
    check(paused.labels.includes('pause'), 'R9.20', 'pause to add pause on GitHub', `[${paused.labels.join(', ')}]`);

    // Below triage: disabled with an explanation. Writes nothing.
    await readOnlyPrecondition(ctx, { openIssue: true });
    await gotoView(page, 'repo');
    await selectRepo(page, READ_ONLY_REPO);
    const toggles = page.getByRole('button', { name: /^(pause|resume)\b/i });
    await toggles.first().waitFor({ state: 'attached', timeout: 60_000 }).catch(() => fail('R9.20', `pause or resume controls on ${READ_ONLY_REPO}'s Issues`, 'none'));
    const n = await toggles.count();
    for (let i = 0; i < n; i++) check(await toggles.nth(i).isDisabled(), 'R9.20', `pause/resume disabled on ${READ_ONLY_REPO}`, 'an enabled control');
    const why = `${await bodyText(page)} ${(await toggles.first().getAttribute('title')) ?? ''} ${(await toggles.first().getAttribute('aria-description')) ?? ''}`;
    check(/triage|permission/i.test(why), 'R9.20', 'an explanation that triage permission is needed', 'none');

    await sleep(90_000);
    const starts = startsInWindow(watcher.starts(), from, Date.now());
    if (starts.length) {
      const open = await gh.list<{ number: number }>(`/repos/${ctx.sandbox.execution}/pulls?state=open`);
      fail('R4.9 via R9.20', 'no local Job after resuming fixture F (blocked by the open, undelivered A)', `${starts.length} Nibfin container start(s) at ${starts.map((s) => new Date(s.at).toISOString()).join(', ')}; open PRs: ${open.map((p) => p.number).join(', ') || 'none'}`);
    }
    notes.push('F resumed and paused without confirmation and read back; no local Job; disabled below triage');
  } finally {
    await dash.stop();
    await watcher.stop();
  }
}

export const dashboardOperations = defineScenario({
  id: 'dashboard-operations',
  rules: ['R9.12', 'R9.13', 'R9.18', 'R9.20', 'R9.21', 'R9.22', 'R9.6'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    const notes: string[] = [];
    const f = await ensureFixtures(ctx.github, ctx.sandbox);
    const schema = await commandSchema(ctx, secrets);
    const dash = await startDashboard(ctx, secrets);
    try {
      const { page } = await openPage(ctx);
      await openDashboard(page, dash);
      await commandDialogs(page, ctx, schema, notes);
      await planningProgress(page, ctx, notes);
      await failedPlan(page, ctx, notes);
    } finally {
      await dash.stop();
    }
    await runnerCycle(ctx, secrets, notes);
    await pauseResume(ctx, secrets, f, notes);
    return notes.join('; ');
  },
});
