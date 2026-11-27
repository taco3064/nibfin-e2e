// fix-loops (Issue #472): F's body allows the CHANGELOG/README updates its hook rules
// require only after a failure asks for them, and its waits end once F gets pending.
import { equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { DEADLINE, Kit, changeRequest } from '../../scenarios/lifecycle/kit.ts';
import { FIX_LOOPS_EXTRA, pendingGone } from '../../scenarios/lifecycle/phase2-fixtures.ts';
import { clock, context, routes } from './fake.ts';

const MIN = 60_000;
const base = { 'GET /repos/o/peer/actions/runs': { workflow_runs: [] }, 'GET /repos/o/peer/issues': [], 'GET /repos/o/peer/pulls': [], 'GET /repos/o/exec/pulls': [], 'GET /repos/o/exec/actions/runs': { workflow_runs: [] }, 'GET /rate_limit': {} };
const issue = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: 't', state: 'open', labels: [{ name: 'scope' }], ...extra });
const blocked = [{ id: 1, body: '<!-- nibfin:pending -->\nDeliver stopped: CHANGELOG.md is outside the Issue (tok-9).', created_at: '', updated_at: '', user: null, html_url: '' }];

test('F\'s body keeps the two-file limit and allows CHANGELOG.md or README.md only when a CI or CD failure asks for them', () => {
  const body = changeRequest('f-abc', 'cube', 'returns its argument cubed', FIX_LOOPS_EXTRA);
  match(body, /Keep the change to these two files\./);
  const extra = body.split('\n\n').find((p) => p.startsWith('Exception:')) ?? '';
  match(extra, /if a CI or CD failure on this Issue reports/);
  match(extra, /`CHANGELOG\.md`/);
  match(extra, /`README\.md`/);
  match(extra, /Do not touch those files otherwise\./);
  equal(extra.includes('f-abc'), false, 'the exception does not name the entry to add');
});

test('a fix-loops wait guarded by closeGone ends on the first fresh snapshot where F has pending, with its last Nibfin comment', async () => {
  let issues: unknown[] = [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }] })];
  const f = routes({ ...base, 'GET /repos/o/exec/issues': () => issues, 'GET /repos/o/exec/issues/6/comments': blocked });
  const c = clock();
  const k = new Kit(context(f.github, { secretValues: () => ['tok-9'] }), { now: c.now, sleep: c.sleep });
  const started = c.now();
  let polls = 0;
  await rejects(
    k.obs.until('a marked review comment on F\'s PR after the harness commit', () => {
      if (++polls === 2) issues = [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }, { name: 'pending' }] })];
      return undefined;
    }, DEADLINE.stage, k.show('o/exec', 6), { gonePast: k.closeGone('o/exec', 6) }),
    /^Error: gave up waiting for a marked review comment on F's PR after the harness commit: #6 has pending; last Nibfin comment: Deliver stopped: CHANGELOG\.md is outside the Issue \(\*\*\*\)\./,
  );
  equal(c.now() - started < 10 * MIN, true, 'it ended long before the stall limit');
});

test('pendingGone does not end the branch-deletion wait for F closed with delivered, and ends it once F has pending', async () => {
  let labels = [{ name: 'delivered' }];
  const f = routes({ ...base, 'GET /repos/o/exec/issues': () => [issue(6, { state: 'closed', state_reason: 'completed', closed_at: '2026-11-26T10:00:00Z', labels })], 'GET /repos/o/exec/issues/6/comments': blocked });
  const c = clock();
  const k = new Kit(context(f.github, { secretValues: () => ['tok-9'] }), { now: c.now, sleep: c.sleep });
  const gone = pendingGone(k, 'o/exec', 6);
  equal(await gone(await k.obs.fresh()), undefined);
  c.advance(MIN);
  labels = [{ name: 'delivered' }, { name: 'pending' }];
  equal(
    await gone(await k.obs.fresh()),
    '#6 has pending after closing with delivered; o/exec#6 closed (completed) [delivered, pending] runs: none; last Nibfin comment: Deliver stopped: CHANGELOG.md is outside the Issue (***).',
  );
});
