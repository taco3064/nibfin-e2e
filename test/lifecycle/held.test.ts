// The shared hold check of lifecycle waits (Proposal R1.14, R4.12, R4.13): a wait naming
// an Issue ends early, with a named reason, once the Issue is closed, has a `pending` the
// repair stage does not clear, or has a `pause` the harness did not add.
import { equal, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { DEADLINE, Kit, STALL } from '../../scenarios/lifecycle/kit.ts';
import { Observer } from '../../scenarios/lifecycle/observe.ts';
import { clock, context, routes } from './fake.ts';

const MIN = 60_000;
const START = Date.parse('2026-11-26T10:00:00Z');
const iso = (t: number) => new Date(t).toISOString();

/**
 * A kit over one Issue, #6 of o/exec, whose state and labels the test sets; the label
 * writes of `Kit.addLabels` and `Kit.removeLabel` change them as GitHub would. `pending`
 * was added at `pendingAt` (default 15 min before the start, past `REPAIR_GRACE`).
 */
function setup(o: { labels?: string[]; pendingAt?: number; state?: Record<string, unknown> } = {}) {
  const st = { labels: o.labels ?? ['scope'], extra: o.state ?? {} };
  const f = routes({
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': () => [
      { number: 6, title: 't', state: 'open', labels: st.labels.map((name) => ({ name })), ...st.extra },
    ],
    'GET /repos/o/peer/issues': [],
    'GET /repos/o/exec/pulls': [],
    'GET /repos/o/peer/pulls': [],
    'GET /rate_limit': {},
    'GET /repos/o/exec/issues/6/events': [
      { event: 'labeled', created_at: iso(o.pendingAt ?? START - 15 * MIN), label: { name: 'pending' } },
    ],
    'GET /repos/o/exec/issues/6/comments': [
      {
        id: 1,
        body: '<!-- nibfin:pending -->\nNibfin stopped and needs a person (tok-9).',
        created_at: '',
        updated_at: '',
        user: null,
        html_url: 'https://github.com/o/exec/issues/6#issuecomment-1',
      },
    ],
    'POST /repos/o/exec/issues': (body) => {
      st.labels = [...((body?.labels as string[] | undefined) ?? [])];
      return { number: 6, title: 't', state: 'open', labels: st.labels.map((name) => ({ name })) };
    },
    'POST /repos/o/exec/issues/6/labels': (body) => {
      for (const l of (body?.labels as string[] | undefined) ?? []) if (!st.labels.includes(l)) st.labels.push(l);
      return [];
    },
    'DELETE /repos/o/exec/issues/6/labels/pause': () => {
      st.labels = st.labels.filter((l) => l !== 'pause');
      return { status: 204 };
    },
  });
  const c = clock(START);
  const k = new Kit(context(f.github, { secretValues: () => ['tok-9'] }), { now: c.now, sleep: c.sleep });
  return { c, k, st };
}

/** A goal that is reached on the given poll. */
const onPoll = (n: number) => {
  let polls = 0;
  return () => (++polls >= n ? true : undefined);
};

test('a wait naming an Issue ends early once it is closed without delivered past the grace', async () => {
  const { c, k } = setup({
    state: { state: 'closed', state_reason: 'not_planned', closed_at: iso(START - 5 * MIN) },
  });
  const started = c.now();
  await rejects(
    k.obs.until('#6 to be shaped', () => undefined, DEADLINE.stage, undefined, k.about('o/exec', 6)),
    /^Error: gave up waiting for #6 to be shaped: #6 is closed \(not_planned\) without delivered$/,
  );
  equal(c.now() - started < 2 * MIN, true, 'it ended on the first snapshot');
});

test('a wait naming an Issue ends early on a pending with no repair record past the grace, quoting the last Nibfin comment', async () => {
  const { c, k } = setup({ labels: ['scope', 'pending'] });
  const started = c.now();
  await rejects(
    k.obs.until('#6 to be shaped', () => undefined, DEADLINE.stage, undefined, k.about('o/exec', 6)),
    /^Error: gave up waiting for #6 to be shaped: #6 has pending; no repair record 15 min after pending was added at 2026-11-26T09:45:00\.000Z; last Nibfin comment: Nibfin stopped and needs a person \(\*\*\*\)\.$/,
  );
  equal(c.now() - started < 2 * MIN, true, 'it ended on the first snapshot');
});

test('a wait naming an Issue ends early on a pause the scenario did not add, naming the Issue, pause and the last Nibfin comment', async () => {
  const { c, k } = setup({ labels: ['scope', 'pause'] });
  const started = c.now();
  await rejects(
    k.obs.until('#6 to be shaped', () => undefined, DEADLINE.stage, undefined, k.about('o/exec', 6)),
    /^Error: gave up waiting for #6 to be shaped: #6 has pause, which the scenario did not add; last Nibfin comment: Nibfin stopped and needs a person \(\*\*\*\)\.$/,
  );
  equal(c.now() - started < STALL, true, 'it ended long before the stall limit');
});

test('a peer Issue is named with its repository', async () => {
  const f = routes({
    'GET /repos/o/exec/actions/runs': { workflow_runs: [] },
    'GET /repos/o/peer/actions/runs': { workflow_runs: [] },
    'GET /repos/o/exec/issues': [],
    'GET /repos/o/peer/issues': [{ number: 3, title: 't', state: 'open', labels: [{ name: 'pause' }] }],
    'GET /repos/o/exec/pulls': [],
    'GET /repos/o/peer/pulls': [],
    'GET /repos/o/peer/issues/3/comments': [],
    'GET /rate_limit': {},
  });
  const c = clock(START);
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  await rejects(
    k.obs.until('Q to close', () => undefined, DEADLINE.stage, undefined, k.about('o/peer', 3)),
    /^Error: gave up waiting for Q to close: o\/peer#3 has pause, which the scenario did not add$/,
  );
});

test('a wait that expects pause keeps going on it', async () => {
  const { k } = setup({ labels: ['scope', 'pause'] });
  equal(
    await k.obs.until('M2 to be shaped', onPoll(3), DEADLINE.stage, undefined, {
      ...k.about('o/exec', 6),
      expects: { pause: 'Nibfin adds pause for the collaborator' },
    }),
    true,
  );
});

test("the harness's own pause keeps a wait going; once removed, a pause on a snapshot read after the removal ends it", async () => {
  const { k, st } = setup();
  await k.addLabels('o/exec', 6, ['pause']);
  equal(await k.obs.until("P's shape job to complete", onPoll(3), DEADLINE.stage, undefined, k.about('o/exec', 6)), true);

  // A snapshot read before the removal finished still shows the harness's own pause.
  const before = await k.obs.fresh();
  await k.removeLabel('o/exec', 6, 'pause');
  equal(await k.heldReason(before, 'o/exec', 6, {}), undefined);

  // The same label seen on a later read is no longer the harness's.
  st.labels.push('pause');
  await rejects(
    k.obs.until('P to be shaped again', () => undefined, DEADLINE.stage, undefined, k.about('o/exec', 6)),
    /^Error: gave up waiting for P to be shaped again: #6 has pause, which the scenario did not add; last Nibfin comment/,
  );
});

test('a paused fixture the harness filed keeps a wait going', async () => {
  const { k } = setup({ labels: [] });
  await k.file('o/exec', { scenario: 's', title: 't', body: 'b', labels: ['request', 'pause'] });
  equal(await k.obs.until('the paused request', onPoll(3), DEADLINE.stage, undefined, k.about('o/exec', 6)), true);
});

test('a pending the harness added itself is still judged: stageGone and a wait without expects end on it; one that expects it keeps going', async () => {
  const { k } = setup();
  await k.addLabels('o/exec', 6, ['pending']);
  const s = await k.obs.fresh();
  equal(
    await k.stageGone('o/exec', 6, 'deliver', { jobs: false })(s),
    '#6 has pending; no repair record 15 min after pending was added at 2026-11-26T09:45:00.000Z; last Nibfin comment: Nibfin stopped and needs a person (***).',
  );
  equal(await k.stageGone('o/exec', 6, 'deliver', { allowPending: true, jobs: false })(s), undefined);
  await rejects(
    k.obs.until("P's PR test check to complete", () => undefined, DEADLINE.stage, undefined, k.about('o/exec', 6)),
    /^Error: gave up waiting for P's PR test check to complete: #6 has pending; no repair record \d+ min/,
  );
  equal(
    await k.obs.until("P's PR test check to complete", onPoll(3), DEADLINE.stage, undefined, {
      ...k.about('o/exec', 6),
      expects: { pending: 'the hold journey added pending itself' },
    }),
    true,
  );
});

test('a pending the repair stage may still clear, within the grace, keeps a wait going', async () => {
  const { k } = setup({ labels: ['scope', 'pending'], pendingAt: START - MIN });
  equal(await k.obs.until('#6 to be shaped', onPoll(3), DEADLINE.stage, undefined, k.about('o/exec', 6)), true);
});

test('stageGone keeps to closure, pending and its stage: a pause does not end it', async () => {
  const { k } = setup({ labels: ['scope', 'pause'] });
  equal(await k.stageGone('o/exec', 6, 'shape', { jobs: false })(await k.obs.fresh()), undefined);
});

test("a scenario's own gonePast reason wins over a hold on the same snapshot", async () => {
  const { k } = setup({ labels: ['scope', 'pause'] });
  await rejects(
    k.obs.until('#6 to be shaped', () => undefined, DEADLINE.stage, undefined, {
      ...k.about('o/exec', 6),
      gonePast: () => 'the scenario knows better',
    }),
    /^Error: gave up waiting for #6 to be shaped: the scenario knows better$/,
  );
});

test('a wait with noIssue gets no hold check', async () => {
  const { k } = setup({ labels: ['scope', 'pause', 'pending'] });
  equal(
    await k.obs.until('the runs to complete', onPoll(3), DEADLINE.stage, undefined, {
      noIssue: 'it waits on runs',
    }),
    true,
  );
});

test('a wait naming Issues on an observer without a hold check throws at once', async () => {
  const c = clock(START);
  const obs = new Observer(routes({}).github, ['o/exec'], { since: c.now(), now: c.now, sleep: c.sleep });
  await rejects(
    obs.until('A to close', () => true, DEADLINE.stage, undefined, { issues: [{ repo: 'o/exec', n: 6 }] }),
    /^Error: waiting for A to close: no hold check installed for the Issues it names$/,
  );
});
