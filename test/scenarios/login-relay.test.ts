// The Dashboard login relay's dialog steps (Proposal R6.16, R1.14): the provider, the
// start control and the URL wait each record their outcome, and the failure when no
// https URL is relayed names those outcomes and what the dialog showed.
import { equal, match, ok } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { BrowserContext, Locator, Page } from 'playwright-core';
import { relayedLoginUrl } from '../../scenarios/dashboard/login-relay.ts';
import { browserLaunchOptions } from '../../scenarios/dashboard/support.ts';
import { childEnv } from '../../src/host/exec.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WAITS = { startMs: 1_000, urlMs: 1_000, pollMs: 50 };
const PREFIX = 'R6.16: expected the dialog to relay the URL the CLI printed; observed no https URL after ';
const LOGIN_URL = 'https://claude.ai/oauth/authorize?code=example';

let context: BrowserContext | undefined;
let page: Page | undefined;
let skipped = '';

/**
 * Launches Chrome the way `openPage` does: the Chrome channel, then `which google-chrome`. Its own
 * profile directory lets it run beside the other browser tests, which node runs in parallel.
 */
async function launch(): Promise<BrowserContext> {
  const { profileDir, options } = browserLaunchOptions(
    join(ROOT, '.e2e-work', 'test-browser-login-relay'),
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
  } catch (error) {
    if (process.env.CI) throw error;
    skipped = `no browser could be launched: ${(error as Error).message.split('\n')[0]}`;
  }
});

after(async () => {
  await context?.close().catch(() => {});
});

/** Renders a dialog with `body` and returns it, or undefined when the test is skipped. */
async function render(t: { skip(m: string): void }, body: string): Promise<Locator | undefined> {
  if (!page) {
    t.skip(skipped);
    return undefined;
  }
  page.setDefaultTimeout(5000);
  await page.setContent(`<!doctype html><html><body><div role="dialog" aria-label="Login">${body}</div></body></html>`);
  return page.getByRole('dialog');
}

const reason = async (d: Locator): Promise<string> => {
  try {
    await relayedLoginUrl(d, WAITS);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected relayedLoginUrl to fail');
};

test('a start control that appears late is clicked and the link it shows is relayed', async (t) => {
  const d = await render(
    t,
    `<p id="out">Choose a provider</p><script>
      setTimeout(() => {
        const b = document.createElement('button');
        b.textContent = 'Start login';
        b.onclick = () => {
          b.dataset.clicked = 'yes';
          const a = document.createElement('a');
          a.href = ${JSON.stringify(LOGIN_URL)};
          a.textContent = 'Open the login page';
          document.querySelector('[role=dialog]').append(a);
        };
        document.querySelector('[role=dialog]').append(b);
      }, 200);
    </script>`,
  );
  if (!d || !page) return;
  equal(await relayedLoginUrl(d, WAITS), LOGIN_URL);
  equal(await d.getByRole('button', { name: 'Start login' }).getAttribute('data-clicked'), 'yes');
});

test('no start control and no LOGIN_URL: the reason names the missing control and the buttons shown', async (t) => {
  const d = await render(t, '<p>Login</p><button>Close</button>');
  if (!d) return;
  const m = await reason(d);
  ok(m.startsWith(PREFIX), m);
  match(m, /provider: no provider field/);
  match(m, /start: no \/\^\(start\|log \?in\|continue\|next\|preview\|confirm\)\\b\/i control appeared within 1(\.\d)? s; buttons shown: "Close"/);
  match(m, /dialog buttons: "Close"; dialog fields: none; dialog text ends: "Login Close"$/);
});

test('an "already logged in" dialog without a LOGIN_URL: the reason quotes that state', async (t) => {
  const d = await render(t, '<p>Claude is already logged in.</p><button>Close</button>');
  if (!d) return;
  const m = await reason(d);
  ok(m.startsWith(PREFIX), m);
  match(m, /the dialog reports an existing login: "Claude is already logged in\."/);
});

const noClaude =
  '<select aria-label="Provider"><option>codex</option></select><button>Close</button>';

test('a provider field that cannot be set does not stop a dialog that relays a LOGIN_URL', async (t) => {
  const d = await render(t, `${noClaude}<a href="${LOGIN_URL}">Open</a>`);
  if (!d || !page) return;
  page.setDefaultTimeout(500);
  equal(await relayedLoginUrl(d, WAITS), LOGIN_URL);
});

test('a provider field that cannot be set: the reason keeps its error', async (t) => {
  const d = await render(t, noClaude);
  if (!d || !page) return;
  page.setDefaultTimeout(500);
  const m = await reason(d);
  ok(m.startsWith(PREFIX), m);
  match(m, /provider: could not be set: locator\.selectOption: /);
  match(m, /dialog fields: combobox "Provider"/);
});

test('a dialog already showing a code field is not clicked through', async (t) => {
  const d = await render(
    t,
    `<input type="text" aria-label="Code"><button onclick="this.dataset.clicked = 'yes'">Continue</button>`,
  );
  if (!d || !page) return;
  const m = await reason(d);
  match(m, /start: not needed \(the dialog showed a code field\)/);
  equal(await d.getByRole('button', { name: 'Continue' }).getAttribute('data-clicked'), null);
});
