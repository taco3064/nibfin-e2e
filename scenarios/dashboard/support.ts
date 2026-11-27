// Server, browser and page support for the Dashboard and site scenarios.
// Elements are found by accessible role, name and visible text only (Proposal R8.14).
import { mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Locator, Page } from 'playwright-core';
import type { Running } from '../../src/host/exec.ts';
import type { Outcome, RunContext, RuleId, Scenario } from '../../src/types.ts';
import { buttonNamesFromAriaSnapshot, fieldsFromAriaSnapshot, missingButtonMessage, parseJobStarts, parseSessionUrl, redact, updateMarkerState } from './checks.ts';
import type { ContainerStart, FormField, Reply, SessionUrl } from './checks.ts';
import { sleep, until } from './github.ts';

// ---- Scenario wrapper ---------------------------------------------------------

export interface Secrets {
  /** Registers a value that must never reach a reason or a log line. */
  add(value: string): void;
}

/**
 * A linux scenario whose reasons never carry a session proof or a registered secret.
 * `run` returns the passed reason or throws the failure.
 */
export function defineScenario(def: {
  id: string;
  rules: RuleId[];
  requires?: string[];
  run(ctx: RunContext, secrets: Secrets): Promise<string>;
}): Scenario {
  return {
    id: def.id,
    rules: def.rules,
    platforms: ['linux'],
    requires: def.requires,
    async run(ctx): Promise<Outcome> {
      const seen = new Set<string>();
      const secrets: Secrets = { add: (v) => void seen.add(v) };
      const safeCtx: RunContext = { ...ctx, log: (m) => ctx.log(redact(m, seen)) };
      try {
        return { status: 'passed', reason: redact(await def.run(safeCtx, secrets), seen) };
      } catch (error) {
        return { status: 'failed', reason: redact(error instanceof Error ? error.message : String(error), seen) };
      }
    },
  };
}

// ---- Dashboard server ---------------------------------------------------------

export interface Dashboard extends SessionUrl {
  child: Running;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no free port'))));
    });
  });
}

/** True when nothing accepts connections on 127.0.0.1:<port> any more. */
export function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port, timeout: 3000 });
    s.once('connect', () => (s.destroy(), resolve(false)));
    s.once('timeout', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(true));
  });
}

/** One HTTP request to the Dashboard on 127.0.0.1 with exactly the given headers. */
export function call(port: number, method: string, path: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, timeout: 15_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

const SESSION = /http:\/\/127\.0\.0\.1:\d+\/\S*#\S*proof=\S+/;

/** Starts `gh nibfin dashboard --no-browser` and reads its session URL. The proof stays in memory. */
export async function startDashboard(ctx: RunContext, secrets: Secrets, opts: { path?: string } = {}): Promise<Dashboard> {
  const attemptStart = async (port: string) => {
    const child = ctx.startGhNibfin(['dashboard', '--no-browser', '--port', port], { path: opts.path });
    try {
      const m = await child.waitFor(SESSION, 90_000);
      const parsed = parseSessionUrl(m[0]);
      if (!parsed) throw new Error('R9.26: expected the session proof only in the URL fragment; observed a session URL without it there');
      secrets.add(parsed.proof);
      return { ...parsed, child, stop: async () => void (await child.stop()) };
    } catch (error) {
      await child.stop();
      throw error;
    }
  };
  try {
    return await attemptStart('0');
  } catch (first) {
    try {
      return await attemptStart(String(await freePort()));
    } catch (second) {
      throw new Error(`gh nibfin dashboard did not start: with --port 0: ${redact(String(first))}; with a free port: ${redact(String(second))}`, { cause: second });
    }
  }
}

// ---- Browser --------------------------------------------------------------------

export interface OpenedPage {
  page: Page;
  context: BrowserContext;
  close(): Promise<void>;
}

let profiles = 0;

/** A headless Google Chrome page with a fresh profile under `.e2e-work/browser/`, closed when the scenario ends. */
export async function openPage(ctx: RunContext, opts: { width?: number; height?: number; locale?: string; timezoneId?: string } = {}): Promise<OpenedPage> {
  const work = ctx.workDir();
  const dir = join(work, 'browser', String(++profiles));
  const tmp = join(work, 'browser', 'tmp');
  // Chrome and fontconfig write under HOME and the XDG directories (for example ~/.pki/nssdb).
  const home = join(work, 'browser', 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(home, { recursive: true });
  const options = {
    headless: true,
    env: {
      ...ctx.browserEnv(),
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
    },
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 },
    locale: opts.locale ?? 'en-US',
    timezoneId: opts.timezoneId ?? 'UTC',
    downloadsPath: tmp,
    artifactsDir: join(work, 'browser', 'artifacts'),
  };
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(dir, { ...options, channel: 'chrome' });
  } catch (error) {
    const which = await ctx.exec(['which', 'google-chrome']);
    if (which.code !== 0) throw new Error(`cannot launch Google Chrome: ${(error as Error).message.split('\n')[0]}`, { cause: error });
    context = await chromium.launchPersistentContext(dir, { ...options, executablePath: which.stdout.trim() });
  }
  const close = async () => {
    await context.close().catch(() => {});
  };
  ctx.defer(close);
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15_000);
  return { page, context, close };
}

/** Marks the current document so a later reload can be detected (Proposal R9.23, R9.24 "without a reload"). */
export async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => ((globalThis as unknown as Record<string, string>).__e2eDocument = 'e2e-298'));
}

export async function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as unknown as Record<string, string>).__e2eDocument === 'e2e-298');
}

// ---- Views and elements ----------------------------------------------------------

export type View = 'person' | 'repo' | 'runner';

export const VIEW_NAME: Record<View, RegExp> = {
  person: /^\s*(me|my\b.*|mine|people|person|assigned.*|for you|you)\s*$/i,
  repo: /^\s*(repo|repos|repository|repositories)\b/i,
  runner: /^\s*(runner|runners)\s*$/i,
};

/** The top-level control that switches to a view: a tab, a navigation link or a button. */
export async function viewControl(page: Page, view: View): Promise<Locator> {
  const name = VIEW_NAME[view];
  const candidates = [
    page.getByRole('tablist').getByRole('tab', { name }),
    page.getByRole('navigation').getByRole('link', { name }),
    page.getByRole('navigation').getByRole('button', { name }),
    page.getByRole('tab', { name }),
    page.getByRole('link', { name }),
    page.getByRole('button', { name }),
  ];
  for (const c of candidates) if ((await c.count()) > 0) return c.first();
  throw new Error(`no top-level control for the ${view} view (looked for a tab, link or button named ${name})`);
}

export async function gotoView(page: Page, view: View): Promise<void> {
  await (await viewControl(page, view)).click();
  await page.waitForTimeout(500);
}

/** The view whose control is marked selected or current. */
export async function activeView(page: Page): Promise<View | undefined> {
  for (const v of ['person', 'repo', 'runner'] as View[]) {
    const c = await viewControl(page, v).catch(() => undefined);
    if (!c) continue;
    const marks = await c.evaluate((el) => [el.getAttribute('aria-selected'), el.getAttribute('aria-current'), el.getAttribute('aria-pressed'), el.getAttribute('data-state')]);
    if (marks.some((m) => m === 'true' || m === 'page' || m === 'active')) return v;
  }
  return undefined;
}

/** Opens the session URL and waits for the three views to be offered. */
export async function openDashboard(page: Page, dash: Dashboard): Promise<void> {
  await page.goto(dash.sessionUrl, { waitUntil: 'domcontentloaded' });
  const end = Date.now() + 60_000;
  for (;;) {
    const found = await Promise.all((['person', 'repo', 'runner'] as View[]).map((v) => viewControl(page, v).then(() => true, () => false)));
    if (found.every(Boolean)) break;
    if (Date.now() > end) throw new Error(`R9.14: expected three top-level views (person, repo, Runner); the page offers ${found.filter(Boolean).length}: ${(await bodyText(page)).slice(0, 300)}`);
    await sleep(500);
  }
  await markDocument(page);
}

export async function bodyText(page: Page): Promise<string> {
  return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
}

/** The innermost list item, article, row or group that holds the text. */
export function issueElement(scope: Page | Locator, title: string): Locator {
  return scope.locator('li, article, [role="listitem"], [role="row"], [role="article"]').filter({ hasText: title }).last();
}

/** The stage the track marks current: aria-current, or "stage: X" text. */
export async function currentStage(el: Locator): Promise<string | undefined> {
  const marked = el.locator('[aria-current="step"], [aria-current="true"], [aria-current="page"]');
  if (await marked.count()) return (await marked.first().innerText()).trim() || ((await marked.first().getAttribute('aria-label')) ?? undefined);
  const m = /\b(?:stage|current)\W+(shape|deliver|done)\b/i.exec(await el.innerText());
  return m?.[1];
}

const MARKER_WAIT_MS = 20_000;
const MARKER_POLL_MS = 500;

/**
 * The visible text of each element in the header (or in `main` when there is no header)
 * that holds a non-empty text node of its own, and the scope's whole visible text.
 * Containers without their own text are skipped, so a badge and the Refresh button never merge.
 */
async function headerTexts(page: Page): Promise<{ texts: string[]; text: string }> {
  const header = page.locator('header, [role="banner"]');
  const scope = (await header.count()) ? header : page.locator('main');
  return scope.evaluateAll((roots) => {
    interface El {
      innerText?: string;
      childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
      getClientRects(): { length: number };
      querySelectorAll(s: string): ArrayLike<El>;
    }
    const win = globalThis as unknown as { getComputedStyle(e: El): { visibility: string } };
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const visible = (e: El) => e.getClientRects().length > 0 && win.getComputedStyle(e).visibility !== 'hidden';
    const ownText = (e: El) => Array.from(e.childNodes).some((n) => n.nodeType === 3 && norm(n.textContent) !== '');
    const rs = roots as unknown as El[];
    const texts: string[] = [];
    for (const r of rs) {
      for (const e of [r, ...Array.from(r.querySelectorAll('*'))]) if (visible(e) && ownText(e)) texts.push(norm(e.innerText));
    }
    return { texts, text: norm(rs.filter(visible).map((r) => r.innerText ?? '').join(' ')) };
  });
}

/** Longest wait for a view's first read to finish; the harness's bound for the Dashboard to start. */
const FIRST_READ_WAIT_MS = 90_000;

/**
 * The current view header's update marker (Proposal R9.8): `live` for an exact `Live`;
 * `manual` for `Updates on Refresh`, `Live updates off` or other manual wording.
 * First waits up to 90 s while the view visibly has not finished its first read ("No data
 * yet", or a header showing only "Refreshing…"); R9.8 sets no time limit, so that wait
 * failing throws a first-read error quoting the page text, not an R9.8 failure. Once loaded,
 * waits up to 20 s for the marker and throws `R9.8: …`, quoting the header text, when
 * neither or both are shown.
 */
export async function readUpdateMarker(page: Page): Promise<'live' | 'manual'> {
  const read = async () => {
    const r = await headerTexts(page).catch(() => ({ texts: [] as string[], text: '' }));
    const body = await bodyText(page);
    return { ...r, body, kind: updateMarkerState(r.texts, body) };
  };
  const firstRead = (body: string) =>
    new Error(`the Dashboard view's first read did not finish within ${FIRST_READ_WAIT_MS / 1000} s; the view still shows no loaded data: "${body.slice(0, 300)}"`);
  const loaded = await until(read, (x) => x.kind !== 'loading', FIRST_READ_WAIT_MS, MARKER_POLL_MS);
  if (loaded.kind === 'loading') throw firstRead(loaded.body);
  const r = await until(read, (x) => x.kind === 'live' || x.kind === 'manual', MARKER_WAIT_MS, MARKER_POLL_MS);
  if (r.kind === 'live' || r.kind === 'manual') return r.kind;
  if (r.kind === 'loading') throw firstRead(r.body);
  throw new Error(`R9.8: expected the view header to show exactly one of Live or manual refresh within ${MARKER_WAIT_MS / 1000} s; observed ${r.kind}: "${r.text.slice(0, 300)}"`);
}

/** The open dialog, after it appears. */
export async function dialog(page: Page): Promise<Locator> {
  const d = page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
  await d.waitFor({ state: 'visible', timeout: 15_000 });
  return d;
}

export async function closeDialog(page: Page): Promise<void> {
  const d = page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
  if (!(await d.isVisible().catch(() => false))) return;
  const close = d.getByRole('button', { name: /^(close|cancel|done|dismiss)$/i });
  if (await close.count()) await close.first().click();
  else await page.keyboard.press('Escape');
  await d.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/**
 * A dialog's form fields by role and accessible name, each with its required flag
 * (`required` or `aria-required`) and its options: a select's options, nested options
 * or radios, or the listbox a combobox opens.
 */
export async function dialogFields(d: Locator): Promise<FormField[]> {
  const fields = fieldsFromAriaSnapshot(await d.ariaSnapshot());
  for (const f of fields) {
    const el = d.getByRole(f.role as Parameters<Locator['getByRole']>[0], { name: f.name, exact: true }).first();
    if (!(await el.count())) continue;
    const info = await el.evaluate((e) => {
      const x = e as unknown as { required?: boolean; tagName: string; getAttribute(n: string): string | null; querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> };
      const opts = x.tagName.toLowerCase() === 'select' ? Array.from(x.querySelectorAll('option'), (o) => (o.textContent ?? '').trim()) : [];
      return { required: x.required === true || x.getAttribute('aria-required') === 'true', options: opts };
    });
    f.required = info.required;
    if (info.options.length) f.options = info.options;
    if (!f.options && f.role === 'combobox') {
      await el.click();
      const listed = await d.page().getByRole('option').allInnerTexts();
      await d.page().keyboard.press('Escape');
      if (listed.length) f.options = listed.map((t) => t.trim());
    }
  }
  return fields;
}

/** First button in `scope` whose name matches, or undefined. */
export async function button(scope: Page | Locator, name: RegExp): Promise<Locator | undefined> {
  const b = scope.getByRole('button', { name });
  return (await b.count()) ? b.first() : undefined;
}

/** How long `mustButton` waits for its button; the page's default action timeout (see `openPage`). */
const BUTTON_WAIT_MS = 15_000;
const BUTTON_POLL_MS = 250;
/** Bound on reading the buttons shown for a failure message, so a vanished scope adds little. */
const SHOWN_READ_MS = 2_000;

/**
 * First button in `scope` whose name matches, waiting up to 15 s for one to appear.
 * When none appears, throws `<rule>: expected a <name> button in <where>; observed none`
 * followed by the buttons the scope shows.
 */
export async function mustButton(scope: Page | Locator, name: RegExp, rule: string, where: string): Promise<Locator> {
  const b = scope.getByRole('button', { name });
  const n = await until(() => b.count(), (c) => c > 0, BUTTON_WAIT_MS, BUTTON_POLL_MS);
  if (n > 0) return b.first();
  const root = 'goto' in scope ? scope.locator('body') : scope;
  const shown = await root.ariaSnapshot({ timeout: SHOWN_READ_MS }).then(buttonNamesFromAriaSnapshot, () => undefined);
  throw new Error(missingButtonMessage(rule, name, where, shown));
}

/** Selects or types a repository in the repo view. */
export async function selectRepo(page: Page, repo: string): Promise<void> {
  const box = page.getByRole('combobox').or(page.getByRole('textbox', { name: /repo|owner/i })).or(page.getByRole('searchbox'));
  if (await box.count()) {
    const b = box.first();
    const tag = await b.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      const ok = await b.selectOption({ label: repo }).then(() => true, () => false);
      if (!ok) throw new Error(`the repository list does not offer ${repo}`);
    } else {
      await b.click();
      const option = page.getByRole('option', { name: new RegExp(`^\\s*${escapeRe(repo)}\\s*$`, 'i') });
      if (await option.count()) await option.first().click();
      else {
        await b.fill(repo);
        await b.press('Enter');
      }
    }
  } else {
    const link = page.getByRole('link', { name: new RegExp(escapeRe(repo), 'i') }).or(page.getByRole('button', { name: new RegExp(escapeRe(repo), 'i') }));
    if (!(await link.count())) throw new Error(`no repository picker and no entry for ${repo} in the repo view`);
    await link.first().click();
  }
  await page.waitForTimeout(1000);
}

/** Repository names the repo view offers for selection. */
export async function repoOptions(page: Page): Promise<string[]> {
  const names = new Set<string>();
  const add = (t: string) => {
    for (const m of t.matchAll(/\b[\w.-]+\/[\w.-]+\b/g)) if (!m[0].includes('://')) names.add(m[0]);
  };
  const select = page.locator('select');
  if (await select.count()) for (const t of await select.first().locator('option').allInnerTexts()) add(t);
  const combo = page.getByRole('combobox');
  if (!names.size && (await combo.count())) {
    await combo.first().click();
    for (const t of await page.getByRole('option').allInnerTexts()) add(t);
    await page.keyboard.press('Escape');
  }
  if (!names.size) for (const t of await page.getByRole('listbox').or(page.getByRole('navigation')).allInnerTexts()) add(t);
  return [...names].sort();
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Local Job starts ----------------------------------------------------------

export interface JobWatcher {
  starts(): ContainerStart[];
  stop(): Promise<void>;
}

/** This scenario's own `podman events` child; it records starts of Nibfin image containers. */
export async function watchLocalJobStarts(ctx: RunContext): Promise<JobWatcher> {
  const child = ctx.start(['podman', 'events', '--format', 'json', '--filter', 'type=container', '--filter', 'event=start']);
  await sleep(2000);
  return { starts: () => parseJobStarts(child.output()), stop: async () => void (await child.stop()) };
}

/** `podman ps --format json` with no secret in its environment. */
export const podmanPs = (ctx: RunContext) => ctx.exec(['podman', 'ps', '--format', 'json']);

/** `gh nibfin status [-R repo] --json`, parsed. */
export async function statusJson(ctx: RunContext, repo?: string): Promise<unknown> {
  const r = await ctx.ghNibfin(['status', ...(repo ? ['-R', repo] : []), '--json']);
  if (r.code !== 0) throw new Error(`gh nibfin status${repo ? ` -R ${repo}` : ''} --json exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-1000)}`);
  return JSON.parse(r.stdout);
}

const LOGIN_KEY = /logged|login|signed|auth/i;

function loginValue(x: unknown): boolean | undefined {
  if (x === true) return true;
  if (x === false) return false;
  if (typeof x !== 'string') return undefined;
  if (/^(true|yes|ok|logged[ _-]?in|signed[ _-]?in|valid)$/i.test(x)) return true;
  if (/^(false|no|none|logged[ _-]?out|not[ _-]?logged[ _-]?in|signed[ _-]?out|invalid)$/i.test(x)) return false;
  return undefined;
}

/**
 * Whether the status reports `provider` logged in: true when some object that names the
 * provider (`{provider, loggedIn}`, or a `{<provider>: {loggedIn}}` entry) says so, false
 * when such objects only say it is not, and undefined when the status names no login of
 * the provider.
 */
export function providerLogin(status: unknown, provider: string): boolean | undefined {
  const seen: boolean[] = [];
  const read = (o: object) => {
    for (const [k, x] of Object.entries(o)) {
      if (!LOGIN_KEY.test(k)) continue;
      const v = loginValue(x);
      if (v !== undefined) seen.push(v);
    }
  };
  const visit = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    if (Object.values(o).includes(provider)) read(o);
    for (const [k, x] of Object.entries(o)) {
      if (k === provider && x && typeof x === 'object' && !Array.isArray(x)) read(x);
      visit(x);
    }
  };
  visit(status);
  if (seen.includes(true)) return true;
  return seen.length ? false : undefined;
}

/** True when some object in the status names claude and reports it logged in. */
export function claudeLoggedIn(status: unknown): boolean {
  return providerLogin(status, 'claude') === true;
}
