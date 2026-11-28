// The Dashboard scenarios' repo-view operation lookup (Proposal R9.12, R9.15, R9.16): Init on a
// repository not using Nibfin yet, typed by hand as OWNER/REPO, and Upgrade on one that uses it.
import { equal, match, ok, rejects } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { repoOperation } from '../../scenarios/dashboard/operations.ts';
import { browserLaunchOptions, registerIssueEngine, selectRepo } from '../../scenarios/dashboard/support.ts';
import { childEnv } from '../../src/host/exec.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

let context: BrowserContext | undefined;
let page: Page | undefined;
let skipped = '';

/**
 * Launches Chrome the way `openPage` does: the Chrome channel, then `which google-chrome`.
 * Its own profile directory, because test files run in parallel and a profile admits one browser.
 * The directory name is kept short: Chrome puts its singleton socket under `<base>/tmp/`, and a
 * Unix socket path longer than 107 bytes (as `test-browser-repo-operation` made it on CI) aborts Chrome.
 */
async function launch(): Promise<BrowserContext> {
  await registerIssueEngine();
  const { profileDir, options } = browserLaunchOptions(
    join(ROOT, '.e2e-work', 'tb-repo'),
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

/**
 * A repo view modelled on the Dashboard's picker: collapsed to `Repository <name>` with a
 * Change button; expanded, a search filter first and then the hand-entry OWNER/REPO form.
 * The view offers Upgrade on `o/sandbox` and Init on any other; with `initNowhere`, Upgrade on every one.
 * With `issueFilter`, a "Search Issues" box like the dependency graph's sits outside the picker;
 * with `listOnly`, the expanded picker shows only its list, with no box at all.
 */
function repoView(
  open: string,
  initNowhere = false,
  { issueFilter = false, listOnly = false }: { issueFilter?: boolean; listOnly?: boolean } = {},
): string {
  return `<main>
  ${issueFilter ? '<section id="graph"><input type="search" aria-label="Search Issues"></section>' : ''}
  <section id="picker"></section>
  <section id="ops"></section>
  <script>
    // A block, because setContent keeps the window, so top-level names would be declared twice.
    {
    const picker = document.getElementById('picker');
    const ops = document.getElementById('ops');
    function show(repo) {
      picker.innerHTML = '<p>Repository <strong></strong></p><button type="button" id="change">Change</button>';
      picker.querySelector('strong').textContent = repo;
      picker.querySelector('#change').onclick = expand;
      const adopted = ${initNowhere} || repo === 'o/sandbox';
      ops.innerHTML = '<button type="button">Refresh</button>' +
        (adopted ? '<button type="button">Upgrade</button>' : '<button type="button">Init</button>');
    }
    function expand() {
      if (${listOnly}) {
        picker.innerHTML = '<ul><li><button type="button">o/sandbox</button></li></ul>';
        return;
      }
      picker.innerHTML =
        '<input type="search" aria-label="Search repositories">' +
        '<ul><li><button type="button">o/sandbox</button></li></ul>' +
        '<form aria-label="Open another repository"><input type="text" aria-label="Repository" placeholder="OWNER/REPO">' +
        '<button type="submit">Open</button></form>';
      picker.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        show(picker.querySelector('input[type=text]').value);
      };
    }
    show(${JSON.stringify(open)});
    }
  </script>
</main>`;
}

async function render(t: { skip(m: string): void }, body: string): Promise<Page | undefined> {
  if (!page) {
    t.skip(skipped);
    return undefined;
  }
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  return page;
}

test('Upgrade is found on the adopted repository and Init on one typed as not using Nibfin', async (t) => {
  const p = await render(t, repoView('o/sandbox'));
  if (!p) return;
  equal(await (await repoOperation(p, 'o/sandbox', 'upgrade', 'R9.12')).innerText(), 'Upgrade');
  equal(await (await repoOperation(p, 'o/new', 'init', 'R9.12')).innerText(), 'Init');
  ok((await p.locator('#picker').innerText()).includes('o/new'), 'the typed repository is open');
  equal(await p.getByRole('button', { name: 'Upgrade' }).count(), 0);
});

test('Init offered nowhere fails R9.12 naming the selected repository and the buttons shown', async (t) => {
  const p = await render(t, repoView('o/sandbox', true));
  if (!p) return;
  await rejects(repoOperation(p, 'o/new', 'init', 'R9.12'), (error: Error) => {
    match(error.message, /^R9\.12: expected a \/\^init\\b\/i button in the repo view of o\/new; observed none; buttons shown:/);
    ok(error.message.includes('"Change"'), error.message);
    ok(error.message.includes('"Upgrade"'), error.message);
    return true;
  });
});

test('selectRepo still selects by label in a picker that is only a select', async (t) => {
  const p = await render(
    t,
    '<select aria-label="Repository"><option>o/a</option><option>o/b</option></select>',
  );
  if (!p) return;
  await selectRepo(p, 'o/b');
  equal(await p.locator('select').inputValue(), 'o/b');
});

test('selectRepo still opens a typed repository in a picker that is only the hand-entry box', async (t) => {
  const p = await render(
    t,
    `<form><input type="text" aria-label="Repository" placeholder="OWNER/REPO"><button type="submit">Open</button></form>
     <p id="open"></p>
     <script>
       document.querySelector('form').onsubmit = (e) => {
         e.preventDefault();
         document.getElementById('open').textContent = document.querySelector('input').value;
       };
     </script>`,
  );
  if (!p) return;
  await selectRepo(p, 'o/typed');
  equal(await p.locator('#open').innerText(), 'o/typed');
});

test('selectRepo expands the collapsed picker and leaves an Issue filter outside it empty', async (t) => {
  const p = await render(t, repoView('o/sandbox', false, { issueFilter: true }));
  if (!p) return;
  const filter = p.getByRole('searchbox', { name: 'Search Issues' });
  equal(await (await repoOperation(p, 'o/new', 'init', 'R9.12')).innerText(), 'Init');
  ok((await p.locator('#picker').innerText()).includes('o/new'), 'the typed repository is open');
  equal(await filter.inputValue(), '');
  equal(await (await repoOperation(p, 'o/sandbox', 'upgrade', 'R9.12')).innerText(), 'Upgrade');
  equal(await filter.inputValue(), '');
});

test('selectRepo fails naming the repository when the expanded picker shows no repository box', async (t) => {
  const p = await render(t, repoView('o/sandbox', false, { issueFilter: true, listOnly: true }));
  if (!p) return;
  await rejects(selectRepo(p, 'o/new'), (error: Error) => {
    ok(error.message.includes('o/new'), error.message);
    match(error.message, /no repository box/);
    return true;
  });
  equal(await p.getByRole('searchbox', { name: 'Search Issues' }).inputValue(), '');
});

test('selectRepo skips an unnamed combobox outside the picker and uses the hand-entry box', async (t) => {
  const p = await render(
    t,
    `<select><option>Stage</option><option>Shape</option></select>
     <form><input type="text" aria-label="Repository" placeholder="OWNER/REPO"><button type="submit">Open</button></form>
     <p id="open"></p>
     <script>
       document.querySelector('form').onsubmit = (e) => {
         e.preventDefault();
         document.getElementById('open').textContent = document.querySelector('input').value;
       };
     </script>`,
  );
  if (!p) return;
  await selectRepo(p, 'o/typed');
  equal(await p.locator('#open').innerText(), 'o/typed');
  equal(await p.locator('select').inputValue(), 'Stage');
});

test('selectRepo clicks the matching option of a combobox inside a repository-named group', async (t) => {
  const p = await render(
    t,
    `<div role="group" aria-label="Repository picker">
       <input role="combobox" aria-expanded="false" aria-controls="lb">
       <ul role="listbox" id="lb"><li role="option">o/a</li><li role="option">o/b</li></ul>
     </div>
     <p id="open"></p>
     <script>
       for (const o of document.querySelectorAll('[role=option]'))
         o.onclick = () => { document.getElementById('open').textContent = o.textContent; };
     </script>`,
  );
  if (!p) return;
  await selectRepo(p, 'o/b');
  equal(await p.locator('#open').innerText(), 'o/b');
});
