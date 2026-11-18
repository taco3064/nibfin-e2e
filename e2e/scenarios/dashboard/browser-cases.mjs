import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from './host.mjs';
import { fixture } from './e2e-browser-fixtures.mjs';
import { browserCases } from './e2e-cases.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const select = page => page.getByRole('button',
  { name: /example\/project#1 — Assigned/ }).click();
async function contains(locator, text) {
  assert.ok((await locator.textContent()).includes(text), `Missing: ${text}`);
}

test(browserCases[0], async t => {
  const h = await open(t, fixture(), 'overview');
  const { page } = h;
  await select(page);
  const panel = page.locator('.issue-explanation');
  await contains(panel, 'The selected process exhausted its memory allocation.');
  await contains(panel, 'Historical report');
  for (const text of ['insufficient-evidence', 'Diagnosis denied', 'no-capacity',
    'unavailable', 'unresolved-effect']) {
    await panel.getByRole('button', { name: 'Request read-only diagnosis' }).click();
    await panel.getByRole('status').filter({ hasText: text }).waitFor();
  }
  const diagnoses = h.requests.filter(r => r.url().endsWith('/api/diagnosis'));
  assert.equal(diagnoses.length, 5);
  for (const request of diagnoses) {
    const body = request.postDataJSON();
    assert.equal(body.selection.identity.repository.id, 1);
    assert.equal(body.selection.node_id, 'I_one');
    assert.equal(body.attempt.stage, 'deliver');
    assert.equal(body.attempt.id, '11111111-1111-1111-1111-111111111111');
    assert.equal(body.diagnose, true);
  }
  assert.equal(await panel.getByRole('button').isDisabled(), true);
  for (const action of ['Pause', 'Resume']) {
    await page.locator('#details').getByRole('button', { name: action, exact: true })
      .click();
    await page.getByRole('dialog').waitFor();
    await button(page, 'Confirm request').click();
    const label = action === 'Pause' ? 'present' : 'absent';
    await page.locator('#label-results').getByText(new RegExp(
      `#1: Requested; observed label ${label}; final Core verdict Unknown`)).waitFor();
    const review = h.requests.filter(r => r.url().endsWith('/api/labels') &&
      r.postDataJSON()?.phase === 'review').at(-1).postDataJSON();
    assert.equal(review.repository, 'example/project');
    assert.deepEqual(review.targets, [{ repository_id: 1, issue_id: 1001, number: 1 }]);
    const apply = h.requests.filter(r => r.url().endsWith('/api/labels') &&
      r.postDataJSON()?.phase === 'apply').at(-1).postDataJSON();
    assert.deepEqual(Object.keys(apply).sort(), ['phase', 'review']);
    // Refresh the actual repository observation after the fixed label request.
    await button(page, 'Read snapshot').click();
    await page.locator('#dashboard').waitFor({ state: 'visible' });
  }
  assert.deepEqual(h.errors, []);
});

test(browserCases[1], async t => {
  const h = await open(t, fixture(), 'overview');
  const { page } = h;
  await select(page);
  await page.locator('#details').getByRole('button', { name: 'Pause', exact: true })
    .click();
  await page.getByRole('dialog').waitFor();
  await page.evaluate(async () => {
    const view = await import('/view.js');
    view.selectIssue({ repository: { id: 2, name: 'other/project',
      url: 'https://github.com/other/project' }, id: 1001, number: 1,
    url: 'https://github.com/other/project/issues/1' });
  });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await contains(page.locator('.issue-explanation'), 'Blocker report unavailable.');
  assert.equal(h.requests.filter(r => r.postData()?.includes('"phase":"apply"'))
    .length, 0);
  assert.deepEqual(h.errors, []);
});

test(browserCases[2], async t => {
  const h = await open(t, fixture(), 'overview');
  const { page } = h;
  await select(page);
  await button(page, 'Back to overview').click();
  await page.locator('#overview-search').fill('Assigned');
  await page.evaluate(() => { window.e2eDocument = 'retained'; });
  await h.context.setOffline(true);
  // The producer host documents transport emulation's missing window event.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByText('Disconnected', { exact: false }).first().waitFor();
  h.advance();
  await h.context.setOffline(false);
  await page.locator('#overview-connection').getByText('Connected', { exact: true })
    .waitFor({ timeout: 20000 });
  await page.waitForFunction(() =>
    document.querySelector('.runner-card')?.textContent.includes('idle'),
  null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.e2eDocument), 'retained');
  assert.equal(await page.locator('#assigned-issues .selected').count(), 1);
  assert.equal(await page.locator('#overview-search').inputValue(), 'Assigned');
  const streams = h.requests.filter(r => r.url().endsWith('/api/updates'));
  assert.ok(streams.length >= 2);
  assert.ok(streams.at(-1).headers()['last-event-id']);
  assert.deepEqual(h.errors, []);
});
