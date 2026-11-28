// Proposal R6.16: logging in through the Dashboard only relays the CLI's URL and the pasted code.
import type { Locator } from 'playwright-core';
import {
  buttonNamesFromAriaSnapshot,
  check,
  fail,
  fieldsFromAriaSnapshot,
  LOGIN_START,
  noRelayedUrlObserved,
} from './checks.ts';
import type { FormField, ProviderStep, StartStep } from './checks.ts';
import { sleep, until } from './github.ts';
import {
  claudeLoggedIn,
  closeDialog,
  defineScenario,
  dialog,
  gotoView,
  mustButton,
  openDashboard,
  openPage,
  startDashboard,
  statusJson,
} from './support.ts';
import { RUNNER_LOGIN, setField } from './operations.ts';

/** Deliberately invalid: no authorization can happen, so no person is needed. */
const BOGUS_CODE = 'nibfin-e2e-298-invalid-code';

/** How long the login dialog's start control and relayed URL are awaited, and how often they are read. */
export const RELAY_WAITS = { startMs: 15_000, urlMs: 180_000, pollMs: 250 };

const PROVIDER = /provider/i;
const SNAPSHOT_READ_MS = 2_000;

const firstLine = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0] ?? '';

/** The dialog's fields, or undefined when its aria snapshot cannot be read. */
async function snapshotOf(d: Locator): Promise<{ buttons?: string[]; fields?: FormField[] }> {
  try {
    const snap = await d.ariaSnapshot({ timeout: SNAPSHOT_READ_MS });
    return { buttons: buttonNamesFromAriaSnapshot(snap), fields: fieldsFromAriaSnapshot(snap) };
  } catch {
    return {};
  }
}

/** The https URL the dialog shows: a link's href, else the first https URL in its text. */
async function shownUrl(d: Locator): Promise<string | undefined> {
  const link = d.locator('a[href^="https://"]').first();
  if (await link.count().catch(() => 0)) {
    const href = await link.getAttribute('href').catch(() => null);
    if (href?.startsWith('https://')) return href;
  }
  return /https:\/\/\S+/.exec(await d.innerText().catch(() => ''))?.[0];
}

/**
 * Drives the opened login dialog to the URL the CLI printed (Proposal R6.16): sets the
 * provider to claude when the dialog has a provider field, clicks a {@link LOGIN_START}
 * control unless the dialog already shows a URL or a code field, then waits for the
 * relayed https URL. Without one it fails with the R6.16 reason naming each step's
 * outcome, how long it waited and what the dialog showed (Proposal R1.14).
 */
export async function relayedLoginUrl(d: Locator, waits = RELAY_WAITS): Promise<string> {
  let provider: ProviderStep;
  if (!(await d.getByLabel(PROVIDER).count())) provider = { kind: 'absent' };
  else
    provider = await setField(d, PROVIDER, 'claude').then(
      (): ProviderStep => ({ kind: 'set' }),
      (e: unknown): ProviderStep => ({ kind: 'failed', error: firstLine(e) }),
    );

  const go = d.getByRole('button', { name: LOGIN_START });
  const read = async () => {
    const url = (await d.locator('a[href^="https://"]').count()) > 0;
    const fields = await d.ariaSnapshot({ timeout: SNAPSHOT_READ_MS }).then(fieldsFromAriaSnapshot, () => []);
    const code = fields.some((f) => f.role === 'textbox' && !PROVIDER.test(f.name));
    return { url, code, go: (await go.count()) > 0 };
  };
  const startedAt = Date.now();
  const seen = await until(read, (v) => v.url || v.code || v.go, waits.startMs, waits.pollMs);
  let start: StartStep;
  if (seen.url) start = { kind: 'not-needed', why: 'url' };
  else if (seen.code) start = { kind: 'not-needed', why: 'code field' };
  else if (seen.go) {
    const b = go.first();
    const label = (await b.getAttribute('aria-label')) ?? (await b.textContent()) ?? '';
    await b.click();
    start = { kind: 'clicked', name: label.replace(/\s+/g, ' ').trim() };
  } else start = { kind: 'none', waitedMs: Date.now() - startedAt, shown: (await snapshotOf(d)).buttons };

  const waitedFrom = Date.now();
  const url = await until(() => shownUrl(d), (u) => u !== undefined, waits.urlMs, waits.pollMs);
  if (url) return url;
  const waitedMs = Date.now() - waitedFrom;
  const { buttons, fields } = await snapshotOf(d);
  const text = await d.innerText().catch(() => '');
  fail(
    'R6.16',
    'the dialog to relay the URL the CLI printed',
    noRelayedUrlObserved({ provider, start, waitedMs, buttons, fields, text }),
  );
}

export const dashboardLoginRelay = defineScenario({
  id: 'dashboard-login-relay',
  rules: ['R6.16'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    const dash = await startDashboard(ctx, secrets);
    try {
      const { page } = await openPage(ctx);
      await openDashboard(page, dash);
      await gotoView(page, 'runner');
      await (await mustButton(page, RUNNER_LOGIN, 'R6.16', 'the Runner view')).click();
      const d = await dialog(page);
      const href = await relayedLoginUrl(d);
      secrets.add(href);
      const boxes = d.getByRole('textbox');
      check(
        (await boxes.count()) === 1,
        'R6.16',
        'exactly one field, for the pasted code',
        `${await boxes.count()} text fields`,
      );
      check(
        (await d.locator('input[type="password"]').count()) === 0,
        'R6.16',
        'no credential input besides the code',
        'a password field',
      );
      await boxes.first().fill(BOGUS_CODE);
      await (await mustButton(d, /^(submit|send|continue|log ?in|confirm)\b/i, 'R6.16', 'the code step')).click();
      let text = '';
      const end = Date.now() + 180_000;
      while (Date.now() < end) {
        text = await d.innerText().catch(() => '');
        if (/invalid|fail|error|rejected|denied|could not/i.test(text)) break;
        await sleep(1000);
      }
      check(
        /invalid|fail|error|rejected|denied|could not/i.test(text),
        'R6.16',
        "the CLI's rejection of an invalid code shown as a failure",
        text.slice(-300),
      );
      check(
        !/\b(logged in successfully|login (succeeded|complete)|success)\b/i.test(text),
        'R6.16',
        'no success after an invalid code',
        text.slice(-300),
      );
      await closeDialog(page);
    } finally {
      await dash.stop();
    }
    // Run-state guard, not an R6.16 assertion: later scenarios need the login.
    const status = await statusJson(ctx);
    if (!claudeLoggedIn(status))
      throw new Error(
        'run state: claude is no longer logged in after the cancelled Dashboard login; the run’s login was lost',
      );
    return 'the login dialog relayed the CLI URL and one code field; an invalid code showed as a failure; claude is still logged in';
  },
});
