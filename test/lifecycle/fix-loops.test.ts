// fix-loops (Issue #472): F's body allows the CHANGELOG/README updates its hook rules
// require only after a failure asks for them, and its waits end once F gets pending.
import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { DEADLINE, Kit, STALL, changeRequest } from '../../scenarios/lifecycle/kit.ts';
import {
  FIX_LOOPS_EXTRA,
  fixGone,
  fixJob,
  pendingGone,
  reviewFixProblems,
} from '../../scenarios/lifecycle/phase2-fixtures.ts';
import { createGitHub } from '../../src/host/github.ts';
import { clock, context, routes } from './fake.ts';

const MIN = 60_000;
const base = {
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /repos/o/exec/pulls': [],
  'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
  'GET /rate_limit': {},
};
// The Issue's events: `pending` added past REPAIR_GRACE before the fake clock's start,
// so a `pending` with no repair record ends a wait at once.
const pendingAt = '2026-11-26T09:45:00Z';
const pendingEvents = {
  'GET /repos/o/exec/issues/6/events': [{ event: 'labeled', created_at: pendingAt, label: { name: 'pending' } }],
};
const noRecord = `; no repair record \\d+ min after pending was added at ${escape(new Date(pendingAt).toISOString())}`;
function escape(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: 't',
  state: 'open',
  labels: [{ name: 'scope' }],
  ...extra,
});
const blocked = [
  {
    id: 1,
    body: '<!-- nibfin:pending -->\nDeliver stopped: CHANGELOG.md is outside the Issue (tok-9).',
    created_at: '',
    updated_at: '',
    user: null,
    html_url: '',
  },
];

test("F's body keeps the two-file limit and allows CHANGELOG.md or README.md only when a CI or CD failure asks for them", () => {
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
  const f = routes({
    ...base,
    'GET /repos/o/exec/issues': () => issues,
    'GET /repos/o/exec/issues/6/comments': blocked,
    ...pendingEvents,
  });
  const c = clock();
  const k = new Kit(context(f.github, { secretValues: () => ['tok-9'] }), { now: c.now, sleep: c.sleep });
  const started = c.now();
  let polls = 0;
  await rejects(
    k.obs.until(
      "a marked review comment on F's PR after the harness commit",
      () => {
        if (++polls === 2)
          issues = [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }, { name: 'pending' }] })];
        return undefined;
      },
      DEADLINE.stage,
      k.show('o/exec', 6),
      { gonePast: k.closeGone('o/exec', 6) },
    ),
    new RegExp(
      `^Error: gave up waiting for a marked review comment on F's PR after the harness commit: #6 has pending${noRecord}; last Nibfin comment: Deliver stopped: CHANGELOG\\.md is outside the Issue \\(\\*\\*\\*\\)\\.`,
    ),
  );
  equal(c.now() - started < 10 * MIN, true, 'it ended long before the stall limit');
});

test('pendingGone does not end the branch-deletion wait for F closed with delivered, and ends it once F has pending', async () => {
  let labels = [{ name: 'delivered' }];
  const f = routes({
    ...base,
    'GET /repos/o/exec/issues': () => [
      issue(6, { state: 'closed', state_reason: 'completed', closed_at: '2026-11-26T10:00:00Z', labels }),
    ],
    'GET /repos/o/exec/issues/6/comments': blocked,
  });
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

/** A Kit whose F (#6) has one deliver run 7 with a self-hosted job 21 whose log names REASON ci-failure. */
function fixKit(conclusion: string) {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [
        {
          id: 7,
          display_title: 'Nibfin · o/exec#6 · deliver',
          status: 'completed',
          conclusion,
          created_at: '2026-11-26T10:01:00Z',
          name: 'Nibfin',
          event: 'workflow_dispatch',
          head_sha: 'h',
        },
      ],
    },
    'GET /repos/o/exec/actions/runs/7/jobs': {
      jobs: [
        {
          id: 21,
          run_id: 7,
          name: 'stage',
          status: 'completed',
          conclusion,
          labels: ['self-hosted', 'nibfin-1'],
          runner_name: 'claude-1',
          created_at: '2026-11-26T10:01:00Z',
          started_at: '2026-11-26T10:01:10Z',
          completed_at: '2026-11-26T10:20:00Z',
        },
      ],
    },
    ...pendingEvents,
    'GET /repos/o/exec/actions/jobs/21/logs': { status: 302, headers: { location: 'https://logs.example/21' } },
    'GET /repos/o/exec/issues': [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }, { name: 'pending' }] })],
    'GET /repos/o/exec/issues/6/comments': [
      {
        id: 1,
        body: '<!-- nibfin:pending -->\nNibfin stopped and needs a person. - Code: STAGE_BLOCKED',
        created_at: '',
        updated_at: '',
        user: null,
        html_url: '',
      },
    ],
  });
  const fetchFn = f.fetchFn;
  const withLogs: typeof fetch = async (input, init) =>
    String(input).startsWith('https://logs.example/')
      ? new Response('2026-11-26T10:02:00Z REASON: ci-failure\n')
      : fetchFn(input, init);
  const c = clock();
  return { c, k: new Kit(context(createGitHub(() => 'tok', withLogs)), { now: c.now, sleep: c.sleep }) };
}

test('a ci-failure deliver job that completed with failure does not satisfy the fix wait, which ends at once naming it', async () => {
  const { c, k } = fixKit('failure');
  const started = c.now();
  await rejects(
    k.obs.until(
      'a deliver job with REASON ci-failure',
      (s) => fixJob(k, s, 6, 'ci-failure'),
      DEADLINE.stage,
      k.show('o/exec', 6),
      { gonePast: fixGone(k, 6, 'ci-failure') },
    ),
    /^Error: gave up waiting for a deliver job with REASON ci-failure: #6's ci-failure deliver job 21 \(run 7\) completed with failure; o\/exec#6 open \[scope, shaped, pending\] runs: deliver completed\/failure; last Nibfin comment: Nibfin stopped and needs a person\. - Code: STAGE_BLOCKED/,
  );
  equal(c.now() - started < STALL, true, 'it ended long before the stall check');
  // Started before `from`, as for the review wait, the failed job does not end it.
  match(
    (await fixGone(k, 6, 'ci-failure', Date.parse('2026-11-26T10:05:00Z'))(await k.obs.current())) ?? '',
    new RegExp(`^#6 has pending${noRecord}; last Nibfin comment: Nibfin stopped and needs a person\\. - Code: STAGE_BLOCKED$`),
  );
});

test('a successful ci-failure deliver job satisfies the fix wait', async () => {
  const { k } = fixKit('success');
  const j = await k.obs.until(
    'a deliver job with REASON ci-failure',
    (s) => fixJob(k, s, 6, 'ci-failure'),
    DEADLINE.stage,
    undefined,
    { gonePast: fixGone(k, 6, 'ci-failure') },
  );
  equal(j.id, 21);
  equal(j.run.id, 7);
  equal(await fixJob(k, await k.obs.current(), 6, 'review'), undefined, 'another reason does not');
});

const HARNESS = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);
const ADDS = '/** Adds two numbers. */\nexport function sum(a, b) {\n  return a + b;\n}\n';
const SUBTRACTS = '/** Adds two numbers. */\nexport function sum(a, b) {\n  return a - b;\n}\n';

test('R3.24 passes a review-fixed head that differs from the harness commit and adds, whether or not it descends from it', () => {
  deepEqual(reviewFixProblems({ harness: HARNESS, merged: MERGED, sum: ADDS }), []);
});

test('R3.24 fails when the harness commit itself merged, naming it', () => {
  const p = reviewFixProblems({ harness: HARNESS, merged: HARNESS, sum: ADDS });
  equal(p.length, 1);
  match(p[0] ?? '', new RegExp(`harness commit ${HARNESS} itself was merged`));
});

test('R3.24 fails when the merged head still subtracts, naming both SHAs', () => {
  const p = reviewFixProblems({ harness: HARNESS, merged: MERGED, sum: SUBTRACTS });
  equal(p.length, 1);
  match(p[0] ?? '', /^the merged head still subtracts in sum/);
  match(p[0] ?? '', new RegExp(`merged head ${MERGED}, harness commit ${HARNESS}`));
});

test('R3.24 fails when the merged head has no src/sum.js, naming the merged head', () => {
  const p = reviewFixProblems({ harness: HARNESS, merged: MERGED, sum: undefined });
  equal(p.length, 1);
  match(p[0] ?? '', new RegExp(`the merged head ${MERGED} has no src/sum\\.js`));
});

test('R3.24 reports both problems when the subtracting harness commit itself merged', () => {
  const p = reviewFixProblems({ harness: HARNESS, merged: HARNESS, sum: SUBTRACTS });
  equal(p.length, 2);
  match(p[0] ?? '', /itself was merged/);
  match(p[1] ?? '', /still subtracts in sum/);
});
