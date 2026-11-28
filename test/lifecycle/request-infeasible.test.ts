// request-infeasible's stop wait (Issue #547, Proposal R3.9): `pending` with the stall
// check, then a Nibfin comment read directly and `quiet`, naming what it read on failure.
import { equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { describeComments } from '../../scenarios/lifecycle/analysis.ts';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';
import { DEADLINE, Kit, STALL } from '../../scenarios/lifecycle/kit.ts';
import { awaitInfeasibleStop } from '../../scenarios/lifecycle/requests.ts';
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
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: 't',
  state: 'open',
  labels: [{ name: 'request' }, { name: 'pending' }],
  ...extra,
});
const comment = (id: number, body: string): Comment => ({
  id,
  body,
  created_at: '',
  updated_at: '',
  user: null,
  html_url: '',
});
const MARKED = comment(
  2,
  '<!-- nibfin:pending -->\nOnly a person can decide how this request continues, so Nibfin added `pending`.',
);
const PLAIN = comment(1, 'Thanks for filing this.');

function setup(issues: () => unknown[], comments: () => Comment[]) {
  const f = routes({ ...base, 'GET /repos/o/exec/issues': issues, 'GET /repos/o/exec/issues/6/comments': comments });
  const c = clock();
  const k = new Kit(context(f.github), { now: c.now, sleep: c.sleep });
  return { c, k, f };
}

test('after pending, calm longer than the stall limit does not fail the wait for the comment', async () => {
  const { c, k } = setup(
    () => [issue(6)],
    () => (c.now() - start > STALL + 5 * MIN ? [PLAIN, MARKED] : [PLAIN]),
  );
  const start = c.now();
  await awaitInfeasibleStop(k, 'o/exec', 6, k.show('o/exec', 6));
  equal(c.now() - start > STALL, true, 'it waited past the stall limit');
  equal(c.now() - start < DEADLINE.event, true);
});

test('a marked comment that a cached read missed is still found by a direct read', async () => {
  let comments = [PLAIN];
  const { c, k, f } = setup(
    () => [issue(6)],
    () => comments,
  );
  const s = await k.obs.current();
  equal((await k.obs.comments('o/exec', 6)).length, 1);
  comments = [PLAIN, MARKED];
  // The cache still answers the old read for this snapshot.
  equal((await k.obs.comments('o/exec', 6)).length, 1);
  const before = c.now();
  const reads = f.calls.filter((x) => x.includes('/issues/6/comments')).length;
  await awaitInfeasibleStop(k, 'o/exec', 6, k.show('o/exec', 6));
  equal(c.now(), before, 'no new snapshot was needed');
  equal((await k.obs.current()).gen, s.gen);
  equal(f.calls.filter((x) => x.includes('/issues/6/comments')).length, reads + 1);
});

test('pending without a marked comment fails at the event deadline and lists the comments read', async () => {
  const wrong = comment(3, `<!-- other:thing -->\n${'x'.repeat(120)}`);
  const { c, k } = setup(
    () => [issue(6)],
    () => [PLAIN, wrong],
  );
  const start = c.now();
  await rejects(awaitInfeasibleStop(k, 'o/exec', 6, k.show('o/exec', 6)), (e: Error) => {
    match(
      e.message,
      /^timed out after 30 min waiting for a Nibfin comment on the request; observed: o\/exec#6 open \[request, pending\]/,
    );
    match(e.message, /read 2 comments: #1 no marker "Thanks for filing this\."; #2 no marker "x{80}…"/);
    return true;
  });
  equal(c.now() - start >= DEADLINE.event, true);
  equal(c.now() - start > STALL, true);
});

test('a request closed before pending ends the pending wait at once with the reason', async () => {
  const { c, k } = setup(
    () => [issue(6, { state: 'closed', state_reason: 'not_planned', labels: [{ name: 'request' }] })],
    () => [],
  );
  const start = c.now();
  await rejects(
    awaitInfeasibleStop(k, 'o/exec', 6, k.show('o/exec', 6)),
    /^Error: gave up waiting for the request to get pending: #6 was closed \(not_planned\) before it got pending/,
  );
  equal(c.now() - start < MIN, true, 'it ended on the first snapshot');
});

test('describeComments names the count, each marker and the shortened start of each text', () => {
  equal(describeComments([]), 'read 0 comments');
  equal(
    describeComments([MARKED]),
    'read 1 comment: #1 marker pending "Only a person can decide how this request continues, so Nibfin added `pending`."',
  );
  equal(
    describeComments([PLAIN, comment(4, `<!-- nibfin:scope -->  a\n\n  b ${'y'.repeat(100)}`)]),
    `read 2 comments: #1 no marker "Thanks for filing this."; #2 marker scope "a b ${'y'.repeat(76)}…"`,
  );
});
