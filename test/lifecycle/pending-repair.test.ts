// A stage wait and the repair stage (Proposal R4.40–R4.47): a `pending` the repair stage
// clears itself keeps the wait going within REPAIR_GRACE; any other `pending` ends it at
// once, naming the record's class and why (R1.14).
import { equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { DEADLINE, Kit, REPAIR_GRACE } from '../../scenarios/lifecycle/kit.ts';
import { clock, context, routes } from './fake.ts';

const MIN = 60_000;
const base = {
  'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
  'GET /repos/o/peer/issues': [],
  'GET /repos/o/peer/pulls': [],
  'GET /repos/o/exec/pulls': [],
  'GET /rate_limit': {},
};
const recordUrl = 'https://github.com/o/exec/issues/6#issuecomment-20';
/** The record of the gate run that showed the defect: external temporary, no options or next steps. */
const temporary = [
  '<!-- nibfin:repair -->',
  "Nibfin's repair stage looked at the latest pending stop.",
  '',
  '- Category: external temporary problem',
  '- Reason: The stop for STAGE_NO_PROGRESS looks temporary (network, GitHub or a single agent run).',
  '- Done: dispatched the stage again.',
].join('\n');
const stop = {
  id: 9,
  body: '<!-- nibfin:pending -->\nNibfin stopped and needs a person. - Code: STAGE_NO_PROGRESS',
  created_at: '2026-11-26T09:58:00Z',
  updated_at: '2026-11-26T09:58:00Z',
  user: null,
  html_url: 'https://github.com/o/exec/issues/6#issuecomment-9',
};
const record = (body: string, at = '2026-11-26T09:59:00Z') => ({
  id: 20,
  body,
  created_at: at,
  updated_at: at,
  user: null,
  html_url: recordUrl,
});
const deliverRun = (status: string) => ({
  id: 7,
  display_title: 'Nibfin · o/exec#6 · deliver',
  status,
  conclusion: status === 'completed' ? 'success' : null,
  created_at: '2026-11-26T09:59:30Z',
  name: 'Nibfin',
  event: 'workflow_dispatch',
  head_sha: 'h',
});

/** A Kit over Issue #6 with `pending` added at 09:58, the given comments, labels and runs, all changeable. */
function setup(state: { comments: unknown[]; pending?: boolean; runs?: unknown[] }, secrets: string[] = []) {
  const f = routes({
    ...base,
    'GET /repos/o/exec/actions/runs': () => ({ workflow_runs: state.runs ?? [] }),
    'GET /repos/o/exec/actions/runs/7/jobs': { jobs: [] },
    'GET /repos/o/exec/issues': () => [
      {
        number: 6,
        title: 't',
        state: 'open',
        labels: [{ name: 'scope' }, { name: 'shaped' }, ...(state.pending === false ? [] : [{ name: 'pending' }])],
      },
    ],
    'GET /repos/o/exec/issues/6/comments': () => state.comments,
    'GET /repos/o/exec/issues/6/events': [
      { event: 'labeled', created_at: '2026-11-26T09:58:00Z', label: { name: 'pending' } },
    ],
  });
  const c = clock();
  const k = new Kit(context(f.github, { secretValues: () => secrets }), { now: c.now, sleep: c.sleep });
  return { c, k, gone: k.closeGone('o/exec', 6) };
}

test('a pending with an external-temporary record does not end the wait, past the grace while a run of the Issue is active, and the wait succeeds once pending is removed', async () => {
  const state: { comments: unknown[]; pending?: boolean; runs?: unknown[] } = {
    comments: [stop, record(temporary)],
  };
  const { c, k, gone } = setup(state);
  equal(await gone(await k.obs.fresh()), undefined, 'one minute after the record');
  c.advance(8 * MIN);
  equal(await gone(await k.obs.fresh()), undefined, 'nine minutes after the record');
  state.runs = [deliverRun('in_progress')];
  c.advance(20 * MIN);
  equal(await gone(await k.obs.fresh()), undefined, 'past the grace while a run of #6 is in progress');
  state.runs = [deliverRun('queued')];
  equal(await gone(await k.obs.fresh()), undefined, 'past the grace while a run of #6 is queued');

  state.pending = false;
  state.runs = [deliverRun('completed')];
  const done = await k.obs.until(
    'pending to be removed',
    (s) => (k.labels(s, 'o/exec', 6).includes('pending') ? undefined : true),
    DEADLINE.stage,
    undefined,
    { gonePast: gone },
  );
  equal(done, true);
});

test('a pending whose record the repair stage does not clear ends the wait at once, naming the class and quoting the record', async () => {
  const decision = [
    '<!-- nibfin:repair -->',
    '- 分類：產品決策',
    '- 原因：The Issue asks for two incompatible outputs.',
    '',
    '### 選項',
    '1. Keep the JSON output (建議)',
    '2. Keep the text output',
  ].join('\n');
  const a = setup({ comments: [stop, record(decision)] });
  match(
    (await a.gone(await a.k.obs.fresh())) ?? '',
    /^#6 has pending; repair record class product-decision, which Nibfin does not clear automatically; repair record https:\/\/github\.com\/o\/exec\/issues\/6#issuecomment-20: - 分類：產品決策/,
  );

  const steps = `${temporary}\n\n### Next steps\n1. Raise the provider quota.`;
  const b = setup({ comments: [stop, record(steps)] });
  match(
    (await b.gone(await b.k.obs.fresh())) ?? '',
    /^#6 has pending; repair record class external-temporary gives options or next steps, so pending stays; repair record https:\/\/\S+: Nibfin's repair stage looked/,
  );

  const odd = '<!-- nibfin:repair -->\n- Category: something new\n- Reason: unclear.';
  const u = setup({ comments: [stop, record(odd)] });
  match(
    (await u.gone(await u.k.obs.fresh())) ?? '',
    /^#6 has pending; repair record class not recognised, which Nibfin does not clear automatically; repair record \S+: - Category: something new/,
  );

  // A record from before pending was last added is not this stop's record.
  const old = setup({ comments: [record(temporary, '2026-11-26T09:00:00Z'), stop] });
  old.c.advance(REPAIR_GRACE);
  match((await old.gone(await old.k.obs.fresh())) ?? '', /^#6 has pending; no repair record 12 min/);
});

test('a pending with no record is tolerated for REPAIR_GRACE after it was added, and not longer while a run is active', async () => {
  const { c, k, gone } = setup({ comments: [stop], runs: [deliverRun('in_progress')] });
  equal(await gone(await k.obs.fresh()), undefined, 'two minutes after pending');
  c.advance(7 * MIN);
  equal(await gone(await k.obs.fresh()), undefined, 'nine minutes after pending');
  c.advance(MIN);
  equal(
    await gone(await k.obs.fresh()),
    '#6 has pending; no repair record 10 min after pending was added at 2026-11-26T09:58:00.000Z; last Nibfin comment: Nibfin stopped and needs a person. - Code: STAGE_NO_PROGRESS',
  );
});

test('a pending still on REPAIR_GRACE after a clearable record, with no run of the Issue active, ends the wait with that reason', async () => {
  const { c, k, gone } = setup({ comments: [stop, record(temporary)], runs: [deliverRun('completed')] });
  c.advance(REPAIR_GRACE - MIN - 1);
  equal(await gone(await k.obs.fresh()), undefined, 'just under the grace');
  c.advance(1);
  equal(
    await gone(await k.obs.fresh()),
    `#6 has pending 10 min after its external-temporary repair record was last written at 2026-11-26T09:59:00.000Z, and no run of #6 is queued or in progress; repair record ${recordUrl}: Nibfin's repair stage looked at the latest pending stop. - Category: external temporary problem - Reason: The stop for STAGE_NO_PROGRESS looks temporary (network, GitHub or a single agent run). - Done: dispatched the stage again.`,
  );
});

test('a secret inside a repair record is masked in the reason', async () => {
  const body = '<!-- nibfin:repair -->\n- Category: product decision\n- Reason: the token tok-77 was rejected.';
  const { k, gone } = setup({ comments: [stop, record(body)] }, ['tok-77']);
  const reason = (await gone(await k.obs.fresh())) ?? '';
  equal(reason.includes('tok-77'), false, reason);
  match(reason, /the token \*\*\* was rejected/);
});
