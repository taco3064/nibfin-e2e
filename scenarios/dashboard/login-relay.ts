// Proposal R6.16: logging in through the Dashboard only relays the CLI's URL and the pasted code.
import { check } from './checks.ts';
import { sleep } from './github.ts';
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
      await setField(d, /provider/i, 'claude').catch(() => {});
      const go = d.getByRole('button', { name: /^(start|log ?in|continue|next|preview|confirm)\b/i });
      if (await go.count()) await go.first().click();
      const link = d.locator('a[href^="https://"]').first();
      await link.waitFor({ state: 'visible', timeout: 180_000 }).catch(() => {});
      const href =
        (await link.getAttribute('href').catch(() => null)) ?? /https:\/\/\S+/.exec(await d.innerText())?.[0];
      check(
        href && href.startsWith('https://'),
        'R6.16',
        'the dialog to relay the URL the CLI printed',
        'no https URL',
      );
      if (href) secrets.add(href);
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
