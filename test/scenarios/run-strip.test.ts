// The Dashboard scenarios' run-strip wait (Proposal R9.19, R9.2): an Issue element whose run
// strip is still loading is judged once it has loaded, and a missing run control says whether
// the strip was still loading or finished loading without one.
import { equal, match, ok } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { browserLaunchOptions, issueElement, registerIssueEngine } from '../../scenarios/dashboard/support.ts';
import { issueFeatures, runStrip, runsMissing } from '../../scenarios/dashboard/views.ts';
import type { Issue } from '../../scenarios/dashboard/github.ts';
import { childEnv } from '../../src/host/exec.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const URL_A = 'https://github.com/o/r/issues/1';
const A = '[e2e #298] Dashboard fixture A';
const issueA: Issue = {
  id: 1,
  node_id: 'I_1',
  number: 1,
  title: A,
  state: 'open',
  html_url: URL_A,
  labels: [],
  repo: 'o/r',
};
const WAIT = { timeoutMs: 1500, everyMs: 100 };

const card = (strip: string) =>
  `<article><h3>${A}</h3><a href="${URL_A}">#1</a><ol><li>Shape</li><li>Deliver</li><li>Done</li></ol>` +
  `<div id="strip">${strip}</div><button>Resume</button></article>`;

let context: BrowserContext | undefined;
let page: Page | undefined;
let skipped = '';

/** Launches Chrome the way `openPage` does: the Chrome channel, then `which google-chrome`. */
async function launch(): Promise<BrowserContext> {
  await registerIssueEngine();
  // Its own profile, so it can run beside the other browser tests.
  const { profileDir, options } = browserLaunchOptions(
    join(ROOT, '.e2e-work', 'test-browser-run-strip'),
    childEnv(process.env),
    {},
  );
  try {
    return await chromium.launchPersistentContext(profileDir, { ...options, channel: 'chrome' });
  } catch (error) {
    let path: string;
    try {
      path = execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim();
    } catch {
      throw new Error(`cannot launch Google Chrome: ${(error as Error).message.split('\n')[0]}`, { cause: error });
    }
    return chromium.launchPersistentContext(profileDir, { ...options, executablePath: path });
  }
}

before(async () => {
  try {
    context = await launch();
    page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(5000);
  } catch (error) {
    if (process.env.CI) throw error;
    skipped = `no browser could be launched: ${(error as Error).message.split('\n')[0]}`;
  }
});

after(async () => {
  await context?.close().catch(() => {});
});

/** Renders `body` and returns the page, or undefined when the test is skipped. */
async function render(t: { skip(m: string): void }, body: string): Promise<Page | undefined> {
  if (!page) {
    t.skip(skipped);
    return undefined;
  }
  await page.setContent(`<!doctype html><html><body><main>${body}</main></body></html>`);
  return page;
}

test('a strip that loads shortly after is judged to offer its runs', async (t) => {
  const p = await render(
    t,
    `${card('<span>Reading runs…</span>')}<script>setTimeout(() => {
      document.getElementById('strip').innerHTML = '<button>Latest run: success</button>';
    }, 300)</script>`,
  );
  if (!p) return;
  const el = issueElement(p, A);
  const s = await runStrip(el, WAIT);
  equal(s.state, 'shown');
  ok(s.strip, 'the strip button');
  ok(s.waitedMs < WAIT.timeoutMs, `waited ${s.waitedMs} ms`);
  equal((await issueFeatures(el, issueA, s)).runs, true);
});

for (const [what, strip] of [
  ['loading text', '<span>Reading runs…</span>'],
  ['an aria-busy marker', '<span aria-busy="true"></span>'],
] as const) {
  test(`a strip that keeps loading fails as still loading (${what})`, async (t) => {
    const p = await render(t, card(strip));
    if (!p) return;
    const el = issueElement(p, A);
    const s = await runStrip(el, WAIT);
    equal(s.state, 'loading');
    equal(s.strip, undefined);
    ok(s.waitedMs >= WAIT.timeoutMs, `waited ${s.waitedMs} ms`);
    match(runsMissing(s), /still loading after \d+ s/);
    const feats = await issueFeatures(el, issueA, s);
    equal(feats.runs, false);
    ok(feats.track && feats.toggle && feats.link, JSON.stringify(feats));
  });
}

test('an element with no loading state and no run control fails at once as having no run control', async (t) => {
  const p = await render(t, card(''));
  if (!p) return;
  const s = await runStrip(issueElement(p, A), WAIT);
  equal(s.state, 'none');
  ok(s.waitedMs < WAIT.timeoutMs / 2, `waited ${s.waitedMs} ms`);
  match(runsMissing(s), /finished loading with no run control/);
});

test('a strip already shown is judged on the first read, and unrelated loading text does not hold it', async (t) => {
  const p = await render(t, card('<button>Latest run: failure</button><span>Loading avatars</span>'));
  if (!p) return;
  const s = await runStrip(issueElement(p, A), WAIT);
  equal(s.state, 'shown');
  ok(s.waitedMs < WAIT.timeoutMs / 2, `waited ${s.waitedMs} ms`);
});

test('a run link alone offers the runs but is not the clickable strip', async (t) => {
  const p = await render(t, card('<a href="https://github.com/o/r/actions/runs/7">Latest run</a>'));
  if (!p) return;
  const el = issueElement(p, A);
  const s = await runStrip(el, WAIT);
  equal(s.state, 'shown');
  equal(s.strip, undefined);
  equal((await issueFeatures(el, issueA, s)).runs, true);
});
