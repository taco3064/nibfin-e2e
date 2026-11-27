// The Dashboard scenarios' Issue lookup (Proposal R9.19, R9.2): each fixture's own element,
// never a "Waiting on" entry inside another Issue's element that repeats its title and link.
import { equal, match, doesNotMatch, ok } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { browserLaunchOptions, issueElement, registerIssueEngine } from '../../scenarios/dashboard/support.ts';
import { childEnv } from '../../src/host/exec.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO = 'https://github.com/o/r/issues';
const A = '[e2e #298] Dashboard fixture A';
const B = '[e2e #298] Dashboard fixture B';
const P = '[e2e #298] Dashboard fixture P';
const D = '[e2e #298] Dashboard fixture D';

const track = '<ol><li>Shape</li><li>Deliver</li><li>Done</li></ol>';
const cardA = `<article><h3>${A}</h3><a href="${REPO}/1">#1</a>${track}</article>`;
const waitingList = `<p>Waiting on</p><ul><li><a href="${REPO}/1">#1 ${A}</a></li><li><a href="${REPO}/9">#9 ${P}</a></li></ul>`;
const waitingBare = `<p>Waiting on <a href="${REPO}/1">#1 ${A}</a> <a href="${REPO}/9">#9 ${P}</a></p>`;
const cardB = (waiting: string) => `<article><h3>${B}</h3><a href="${REPO}/2">#2</a>${track}${waiting}</article>`;
const cardP = `<article><h3>${P}</h3><a href="${REPO}/9">#9</a>${track}</article>`;

let context: BrowserContext | undefined;
let page: Page | undefined;
let skipped = '';

/** Launches Chrome the way `openPage` does: the Chrome channel, then `which google-chrome`. */
async function launch(): Promise<BrowserContext> {
  await registerIssueEngine();
  const { profileDir, options } = browserLaunchOptions(join(ROOT, '.e2e-work', 'test-browser'), childEnv(process.env), {});
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

async function only(p: Page, title: string) {
  const el = issueElement(p, title);
  equal(await el.count(), 1, `exactly one element for ${title}`);
  return (await el.innerText()).replace(/\s+/g, ' ');
}

const shapes: [string, string][] = [
  ['a Waiting-on entry that is a list item', `<section>${cardA}${cardB(waitingList)}${cardP}</section>`],
  ['a Waiting-on entry that is a bare link', `<section>${cardA}${cardB(waitingBare)}${cardP}</section>`],
  ['cards inside a repository group list item', `<ul><li><h2>o/r</h2><a href="https://github.com/o/r">o/r</a><div>${cardA}${cardB(waitingList)}${cardP}</div></li></ul>`],
  ['B before A and bare Waiting-on links inside a group list item', `<ul><li><h2>o/r</h2>${cardB(waitingBare)}${cardA}${cardP}</li></ul>`],
];

for (const [what, html] of shapes) {
  test(`A's lookup returns A's own card with its track, not B's Waiting-on entry (${what})`, async (t) => {
    const p = await render(t, html);
    if (!p) return;
    const text = await only(p, A);
    match(text, /Shape.*Deliver.*Done/);
    doesNotMatch(text, /fixture B|Waiting on/);
    equal(await issueElement(p, A).locator(`a[href="${REPO}/1"]`).count(), 1);
  });

  test(`B's lookup returns B's card with its Waiting-on content (${what})`, async (t) => {
    const p = await render(t, html);
    if (!p) return;
    const text = await only(p, B);
    match(text, /Waiting on/);
    ok(text.includes(A) && text.includes('#9'), text);
    equal(await issueElement(p, B).locator(`a[href="${REPO}/2"]`).count(), 1);
  });
}

test('an Issue that is not shown matches nothing, even when a Waiting-on entry names it', async (t) => {
  const p = await render(t, `<section>${cardB(waitingList)}</section>`);
  if (!p) return;
  equal(await issueElement(p, D).count(), 0);
  equal(await issueElement(p, A).count(), 0);
});

test('without Issue links the lookup keeps the last list item that holds the title', async (t) => {
  const p = await render(t, `<ul><li>${A} <span>Shape Deliver Done</span></li><li>${B}</li></ul>`);
  if (!p) return;
  match(await only(p, A), /Shape Deliver Done/);
});

test('a scoped lookup matches only inside its scope', async (t) => {
  const p = await render(t, `<section id="one">${cardA}</section><section id="two">${cardB(waitingList)}</section>`);
  if (!p) return;
  equal(await issueElement(p.locator('#two'), A).count(), 0);
  equal(await issueElement(p.locator('#one'), A).count(), 1);
  match(await issueElement(p.locator('#two'), B).innerText(), /Waiting on/);
});

test('registering the Issue engine twice in one process does not throw', async () => {
  await registerIssueEngine();
  await registerIssueEngine();
});
