// Waits of the issue-fixture kit that end early: a goal out of reach, a stall, an abort
// (Issue #334).
import { equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../../scenarios/lib/analysis.ts';
import { DEADLINE, Kit, QUOTE_LIMIT, STALL } from '../../scenarios/lib/issue-kit.ts';
import { Observer } from '../../scenarios/lib/observer.ts';
import { clock, context, routes } from './fake.ts';

const MIN = 60_000;
/** Why a test wait names no Issue: it exercises the wait itself (stall, abort, deadline). */
const NO_ISSUE = 'the test exercises the wait itself';
const base = {
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /repos/o/exec/pulls': [],
  'GET /rate_limit': {},
};
// The Issue's events: `pending` added past REPAIR_GRACE before the fake clock's start,
// so a `pending` with no repair record ends a wait at once.
const pendingAt = '2026-11-26T09:45:00Z';
const pendingEvents = {
  'GET /repos/o/exec/issues/6/events': [{ event: 'labeled', created_at: pendingAt, label: { name: 'pending' } }],
};
/** The part of a pending reason saying no repair record was written; `min` defaults to any count. */
const noRecord = (min?: number) =>
  `; no repair record ${min ?? '\\d+'} min after pending was added at ${new Date(pendingAt).toISOString()}`;
const run = (id: number, stage: string, status: string, created: string, n = 6) => ({
  id,
  display_title: `Nibfin · o/exec#${n} · ${stage}`,
  status,
  conclusion: status === 'completed' ? 'success' : null,
  created_at: created,
  name: 'Nibfin',
  event: 'workflow_dispatch',
  head_sha: 'h',
});
const job = (id: number, runId: number, extra: Partial<Job> = {}): Job => ({
  id,
  run_id: runId,
  name: 'stage',
  status: 'completed',
  conclusion: 'success',
  labels: ['self-hosted', 'nibfin-1'],
  runner_name: 'claude-1',
  created_at: '2026-11-26T10:01:00Z',
  started_at: '2026-11-26T10:01:10Z',
  completed_at: '2026-11-26T10:20:00Z',
  ...extra,
});
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: 't',
  state: 'open',
  labels: [{ name: 'scope' }],
  ...extra,
});

test('a stage wait fails on the first snapshot showing the stage job completed and another stage followed, long before its deadline', async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': {
      workflow_runs: [
        run(5, 'shape', 'completed', '2026-11-26T10:00:30Z'),
        run(7, 'deliver', 'in_progress', '2026-11-26T10:21:00Z'),
      ],
    },
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [job(11, 5)] },
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }] })],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const started = c.now();
  await rejects(
    k.obs.until("I2's shape job to run", () => undefined, DEADLINE.stage, k.show('o/exec', 6), {
      ...k.about('o/exec', 6),
      gonePast: k.stageGone('o/exec', 6, 'shape'),
    }),
    /^Error: gave up waiting for I2's shape job to run: #6's shape job 11 completed \(run 5, success\) and a deliver run 7 followed; observed: o\/exec#6 open \[scope, shaped\]/,
  );
  equal(c.now() - started < MIN, true, 'it ended on the first snapshot');
});

test('a completed stage job is not out of reach while no other stage followed, nor when it is older than the wait', async () => {
  const runs = [
    run(5, 'shape', 'completed', '2026-11-26T09:00:00Z'),
    run(7, 'deliver', 'completed', '2026-11-26T09:30:00Z'),
    run(9, 'shape', 'completed', '2026-11-26T10:00:30Z'),
  ];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: runs },
    'GET /repos/o/exec/actions/runs/5/jobs': {
      jobs: [job(11, 5, { created_at: '2026-11-26T09:00:10Z', completed_at: '2026-11-26T09:20:00Z' })],
    },
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/actions/runs/9/jobs': { jobs: [job(12, 9)] },
    'GET /repos/o/exec/issues': [issue(6)],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const s = await k.obs.next();
  // Job 11 completed before the wait and was followed by deliver 7; job 12 completed with nothing after it.
  equal(await k.stageGone('o/exec', 6, 'shape')(s), undefined);
});

test('a stage wait fails at once when the Issue is closed or has pending, unless pending is allowed', async () => {
  let issues: unknown[] = [];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    ...pendingEvents,
    'GET /repos/o/exec/issues/6/comments': [
      {
        id: 1,
        body: '<!-- nibfin:pending -->\nDeliver stopped: the push was rejected (tok-9).',
        created_at: '',
        updated_at: '',
        user: null,
        html_url: '',
      },
    ],
  });
  const c = clock();
  const k = new Kit(context(f.github, { secretValues: () => ['tok-9'] }), { now: c.now, sleep: c.sleep });
  const gone = k.stageGone('o/exec', 6, 'deliver');
  issues = [issue(6, { labels: [{ name: 'scope' }, { name: 'pending' }] })];
  const s1 = await k.obs.fresh();
  equal(await gone(s1), `#6 has pending${noRecord(15)}; last Nibfin comment: Deliver stopped: the push was rejected (***).`);
  equal(await k.stageGone('o/exec', 6, 'deliver', { allowPending: true })(s1), undefined);
  await rejects(
    k.obs.until("I's deliver job to run", () => undefined, DEADLINE.stage, undefined, { ...k.about('o/exec', 6), gonePast: gone }),
    new RegExp(`gave up waiting for I's deliver job to run: #6 has pending${noRecord()}; last Nibfin comment`),
  );

  // Closed with delivered ends a stage wait at once; closed without it after a grace period, as Nibfin may label after closing.
  c.advance(MIN);
  issues = [
    issue(6, {
      state: 'closed',
      state_reason: 'completed',
      closed_at: new Date(c.now()).toISOString(),
      labels: [{ name: 'delivered' }],
    }),
  ];
  equal(await gone(await k.obs.fresh()), '#6 is closed (completed) with delivered');
  c.advance(MIN);
  issues = [
    issue(6, { state: 'closed', state_reason: 'not_planned', closed_at: new Date(c.now()).toISOString(), labels: [] }),
  ];
  equal(await gone(await k.obs.fresh()), undefined);
  c.advance(2 * MIN);
  equal(await k.stageGone('o/exec', 6, 'review')(await k.obs.fresh()), '#6 is closed (not_planned) without delivered');
});

test('a wait with no sandbox activity fails after the stall limit; one with a run in progress or marked quiet does not', async () => {
  let runs: (ReturnType<typeof run> & { run_attempt?: number })[] = [run(5, 'shape', 'completed', '2026-11-26T10:00:30Z')];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: runs }),
    'GET /repos/o/exec/actions/runs/5/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': [issue(6)],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const started = c.now();
  await rejects(
    k.obs.until("I2's shape job to run", () => undefined, DEADLINE.stage, k.show('o/exec', 6), { noIssue: NO_ISSUE }),
    /^Error: no sandbox activity for 20 min while waiting for I2's shape job to run; observed: o\/exec#6 open/,
  );
  equal(c.now() - started, 20 * MIN);

  // A quiet wait runs to its own deadline.
  await rejects(
    k.obs.until('nothing to happen', () => undefined, 30 * MIN, undefined, { noIssue: NO_ISSUE, quiet: true }),
    /^Error: timed out after 30 min waiting for nothing to happen$/,
  );

  // A run in progress is activity, even when no snapshot changes. It is a re-run: the
  // observer keeps a completed attempt over an unfinished read of the same attempt.
  runs = [{ ...run(5, 'shape', 'in_progress', '2026-11-26T10:00:30Z'), run_attempt: 2 }];
  await rejects(
    k.obs.until("I2's shape job to complete", () => undefined, 45 * MIN, undefined, { noIssue: NO_ISSUE }),
    /^Error: timed out after 45 min waiting for I2's shape job to complete$/,
  );
});

test("a stall counts from the wait's own start, so a wait after a quiet one does not fail at once", async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [],
  });
  const c = clock();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, stallMs: 20 * MIN });
  await rejects(
    obs.until('quiet', () => undefined, 25 * MIN, undefined, { noIssue: NO_ISSUE, quiet: true }),
    /timed out after 25 min/,
  );
  let polls = 0;
  equal(await obs.until('the third look', () => (++polls === 3 ? true : undefined), 60 * MIN, undefined, { noIssue: NO_ISSUE }), true);
});

test("an observer wait ends with the abort reason once the run's signal aborts", async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [],
  });
  const c = clock();
  const ctl = new AbortController();
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, signal: ctl.signal });
  let polls = 0;
  await rejects(
    obs.until(
      'A to close',
      () => (++polls === 2 ? (ctl.abort(new Error('harness budget of 190 min ran out')), undefined) : undefined),
      DEADLINE.delivery,
      undefined,
      { noIssue: NO_ISSUE },
    ),
    /^Error: harness budget of 190 min ran out$/,
  );
  equal(polls, 2);
  // A sleeping observer wakes on the abort (the real sleep would last a minute).
  const ctl2 = new AbortController();
  const slow = new Observer(f.github, ['o/exec'], {
    since: c.now(),
    now: c.now,
    sleep: () => new Promise(() => {}),
    signal: ctl2.signal,
  });
  await slow.next();
  const waiting = slow.until('B', () => undefined, DEADLINE.delivery, undefined, { noIssue: NO_ISSUE });
  setTimeout(() => ctl2.abort(new Error('budget')), 5);
  await rejects(waiting, /^Error: budget$/);
});

test("a wait is not judged on a snapshot taken before it began, such as one still showing the harness's own pending", async () => {
  let labels = [{ name: 'scope' }, { name: 'pending' }];
  let state = 'open';
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => [
      issue(6, { labels, state, closed_at: state === 'closed' ? '2026-11-26T10:01:00Z' : null }),
    ],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await k.obs.next();
  // The harness removes pending; the cached snapshot still shows it.
  labels = [{ name: 'scope' }];
  let polls = 0;
  const closed = await k.obs.until(
    'P to close with delivered',
    (s) => {
      if (++polls === 1) {
        state = 'closed';
        labels = [{ name: 'delivered' }];
      }
      const i = k.issue(s, 'o/exec', 6);
      return i?.state === 'closed' && k.labels(s, 'o/exec', 6).includes('delivered') ? i : undefined;
    },
    DEADLINE.delivery,
    undefined,
    { ...k.about('o/exec', 6), gonePast: k.stageGone('o/exec', 6, 'review') },
  );
  equal(closed.number, 6);
  equal(polls, 2);
});

test('failed reads do not count as calm: the stall limit counts from the last failed refresh', async () => {
  const c = clock();
  const started = c.now();
  // Reads fail from the 1st to the 30th minute.
  const failing = () => c.now() - started >= MIN && c.now() - started < 30 * MIN;
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => (failing() ? { status: 502, data: { message: 'Bad Gateway' } } : { data: [] }),
  });
  const obs = new Observer(f.github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep, stallMs: 20 * MIN });
  await rejects(
    obs.until('A to close', () => undefined, DEADLINE.delivery, undefined, { noIssue: NO_ISSUE }),
    /^Error: no sandbox activity for 20 min while waiting for A to close/,
  );
  const took = (c.now() - started) / MIN;
  equal(took >= 49 && took <= 51, true, `failed after ${took} min`);
});

// Issue #569: the stall check fails only on a recent snapshot judged by gonePast.
const blockedComment = [
  {
    id: 1,
    body: '<!-- nibfin:pending -->\nNibfin stopped and needs a person. - Code: STAGE_BLOCKED',
    created_at: '',
    updated_at: '',
    user: null,
    html_url: '',
  },
];
const pendingIssue = () => [issue(6, { labels: [{ name: 'scope' }, { name: 'shaped' }, { name: 'pending' }] })];

test('a wait whose first pass blocks past the stall limit while the Issue gets pending ends with that reason, not on the stall check', async () => {
  let issues: unknown[] = [issue(6)];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    'GET /repos/o/exec/issues/6/comments': blockedComment,
    ...pendingEvents,
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  let polls = 0;
  await rejects(
    k.obs.until(
      'a marked review comment',
      () => {
        if (++polls === 1) {
          c.advance(STALL + 5 * MIN);
          issues = pendingIssue();
        }
        return undefined;
      },
      DEADLINE.stage,
      k.show('o/exec', 6),
      { ...k.about('o/exec', 6), gonePast: k.stageGone('o/exec', 6, 'review') },
    ),
    new RegExp(
      `^Error: gave up waiting for a marked review comment: #6 has pending${noRecord()}; last Nibfin comment: Nibfin stopped and needs a person\\. - Code: STAGE_BLOCKED`,
    ),
  );
  equal(polls, 1);
});

test("a refresh inside a blocked pass does not stand in for the stall decision's own read", async () => {
  let issues: unknown[] = [issue(6)];
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    'GET /repos/o/exec/issues/6/comments': blockedComment,
    ...pendingEvents,
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  let polls = 0;
  await rejects(
    k.obs.until(
      'a marked review comment',
      async () => {
        if (++polls === 1) {
          await k.obs.fresh();
          c.advance(STALL + 5 * MIN);
          issues = pendingIssue();
        }
        return undefined;
      },
      DEADLINE.stage,
      undefined,
      { ...k.about('o/exec', 6), gonePast: k.stageGone('o/exec', 6, 'review') },
    ),
    new RegExp(
      `^Error: gave up waiting for a marked review comment: #6 has pending${noRecord()}; last Nibfin comment: Nibfin stopped and needs a person\\. - Code: STAGE_BLOCKED`,
    ),
  );
});

test('an observer read blocked on a peer request does not count as recent for the stall check', async () => {
  let issues: unknown[] = [issue(6)];
  let peerReads = 0;
  const c = clock();
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => issues,
    'GET /repos/o/exec/issues/6/comments': blockedComment,
    ...pendingEvents,
    // The wait's first read lists the exec issues, then blocks on the peer's while F gets pending.
    'GET /repos/o/peer/issues': () => {
      if (++peerReads === 2) {
        c.advance(STALL + 5 * MIN);
        issues = pendingIssue();
      }
      return [];
    },
  });
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await k.obs.next();
  await rejects(
    k.obs.until('a marked review comment', () => undefined, DEADLINE.stage, undefined, {
      ...k.about('o/exec', 6),
      gonePast: k.stageGone('o/exec', 6, 'review'),
    }),
    new RegExp(
      `^Error: gave up waiting for a marked review comment: #6 has pending${noRecord()}; last Nibfin comment: Nibfin stopped and needs a person\\. - Code: STAGE_BLOCKED`,
    ),
  );
  equal(peerReads >= 3, true, 'the decision read anew');
});

test('a blocked pass with no gonePast reason and no activity still fails on the stall check', async () => {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [issue(6)],
  });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  const started = c.now();
  let polls = 0;
  const block = () => {
    if (++polls === 1) c.advance(STALL + 5 * MIN);
    return undefined;
  };
  await rejects(
    k.obs.until('a marked review comment', block, DEADLINE.stage, undefined, { ...k.about('o/exec', 6), gonePast: k.stageGone('o/exec', 6, 'review') }),
    /^Error: no sandbox activity for 25 min while waiting for a marked review comment$/,
  );
  equal(c.now() - started, STALL + 5 * MIN);
  // Without gonePast too.
  polls = 0;
  await rejects(k.obs.until('B', block, DEADLINE.stage, undefined, { noIssue: NO_ISSUE }), /^Error: no sandbox activity for 25 min while waiting for B$/);
});

// The pending reason keeps the whole stop reason; summary keeps a short form (Issue #597).
const stopUrl = 'https://github.com/o/exec/issues/6#issuecomment-9';
const blockedUrl = 'https://github.com/o/exec/pull/41#discussion_r1234567890';
const stopBody = (reason: string) =>
  `<!-- nibfin:pending -->\nNibfin stopped and needs a person.\n\n- Code: STAGE_BLOCKED\n- Run: https://github.com/o/exec/actions/runs/46027033527\n\n\`\`\`text\n${reason}\n\`\`\``;
const fenced = `Writer returned blocked (${blockedUrl}): ${'the rebase onto main conflicts in src/app.ts and the other side cannot hold; '.repeat(5)}see ${blockedUrl}`;
const collapse = (body: string) =>
  body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stopKit(body: string, secrets: string[] = []) {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': pendingIssue(),
    ...pendingEvents,
    'GET /repos/o/exec/issues/6/comments': [
      { id: 9, body, created_at: '', updated_at: '', user: null, html_url: stopUrl },
    ],
  });
  const c = clock();
  return new Kit(context(f.github, { secretValues: () => secrets }), { now: c.now, sleep: c.sleep });
}

test('a stop comment of about 600 characters appears in the pending reason in full, the fenced reason and its final URL included', async () => {
  const body = stopBody(fenced);
  const text = collapse(body);
  equal(text.length > 550 && text.length < 700, true, `the comment is about 600 characters (${text.length})`);
  const k = stopKit(body);
  const s = await k.obs.next();
  const reason = await k.stageGone('o/exec', 6, 'shape')(s);
  equal(reason, `#6 has pending${noRecord(15)}; last Nibfin comment: ${text}`);
  equal(reason?.endsWith(`see ${blockedUrl} \`\`\``), true);
  equal(await k.stageGone('o/exec', 6, 'review')(s), reason);
  await rejects(
    k.obs.until('a marked review comment', () => undefined, DEADLINE.stage, undefined, {
      ...k.about('o/exec', 6),
      gonePast: k.stageGone('o/exec', 6, 'review'),
    }),
    new RegExp(
      `^Error: gave up waiting for a marked review comment: #6 has pending${noRecord()}; last Nibfin comment: ${escape(text)}$`,
    ),
  );
});

test('a stop comment over the limit is cut at its end on a whole token, with the dropped count and the comment URL', async () => {
  const body = stopBody(`Writer returned blocked: ${'conflicting-requirement '.repeat(80)}see ${blockedUrl}`);
  const text = collapse(body);
  equal(text.length > QUOTE_LIMIT, true);
  const k = stopKit(body);
  const reason = (await k.stageGone('o/exec', 6, 'shape')(await k.obs.next())) ?? '';
  const m = new RegExp(
    `^#6 has pending${noRecord()}; last Nibfin comment: (.*) … \\(cut, (\\d+) more characters; full comment: (\\S+)\\)$`,
  ).exec(reason);
  equal(!!m, true, reason);
  const [, kept = '', dropped = '', url = ''] = m ?? [];
  equal(url, stopUrl);
  equal(kept.length <= QUOTE_LIMIT, true);
  equal(text.startsWith(kept), true, 'the kept part is the start of the comment');
  equal(text[kept.length], ' ', 'the cut falls on a whole token');
  equal(Number(dropped), text.length - kept.length);
  match(kept, /Code: STAGE_BLOCKED - Run: https:\/\/github\.com\/o\/exec\/actions\/runs\/46027033527 /);
});

test('a secret inside the stop comment is masked in every quote, also one across the cut', async () => {
  const head = stopBody('Writer returned blocked: tok-in-text ');
  const pad = 'x'.repeat(QUOTE_LIMIT - collapse(head).length - 3);
  const body = `${head.slice(0, -4)}${pad}secret-across-the-cut and more text\n\`\`\``;
  const text = collapse(body);
  const at = text.indexOf('secret-across-the-cut');
  equal(at < QUOTE_LIMIT && at + 'secret-across-the-cut'.length > QUOTE_LIMIT, true, 'the secret straddles the limit');
  const k = stopKit(body, ['tok-in-text', 'secret-across-the-cut']);
  const s = await k.obs.next();
  for (const out of [
    await k.stageGone('o/exec', 6, 'shape')(s),
    await k.summary(s, 'o/exec', 6),
  ]) {
    for (const part of ['tok-in-text', 'tok-in', 'secret-across', 'across-the-cut'])
      equal(out?.includes(part), false, `${part} in ${out}`);
  }
  match((await k.stageGone('o/exec', 6, 'shape')(s)) ?? '', /blocked: \*\*\* x/);
});

test('a wait ended by pending holds the stop reason once: in the reason, not again in the observed part', async () => {
  const k = stopKit(stopBody(fenced));
  const err = await k.obs
    .until('a marked review comment', () => undefined, DEADLINE.stage, k.show('o/exec', 6), {
      ...k.about('o/exec', 6),
      gonePast: k.stageGone('o/exec', 6, 'review'),
    })
    .then(
      () => undefined,
      (e: unknown) => String(e),
    );
  equal(err?.split('Writer returned blocked').length, 2, err);
  match(
    err ?? '',
    /; observed: o\/exec#6 open \[scope, shaped, pending\] runs: none; last Nibfin comment: Code: STAGE_BLOCKED, Run: https:\/\/github\.com\/o\/exec\/actions\/runs\/46027033527$/,
  );
});
