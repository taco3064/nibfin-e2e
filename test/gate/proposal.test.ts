import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { parseProposalEvent, proposalUpdated, readState, stateBlock } from '../../src/gate/proposal.ts';
import type { ProposalEvent } from '../../src/gate/proposal.ts';
import { FakeGate } from './fake.ts';

const E2E = 'taco3064/nibfin-e2e';
const env = (runId: string) => ({ runId, serverUrl: 'https://github.com', repository: E2E });

function gate(...runs: string[]) {
  const gh = new FakeGate();
  for (const r of runs) gh.runs.set(r, { created_at: '2026-11-27T09:00:00Z', run_attempt: 1 });
  return gh;
}

const event = (timestamp: string): ProposalEvent => ({ pageId: 'page-1', blockIds: ['b1', 'b2'], timestamp });

test('the dispatch payload is validated', () => {
  const ok = JSON.stringify({
    action: 'proposal-updated',
    client_payload: { page_id: 'p', block_ids: ['b'], timestamp: '2026-11-27T08:00:00+08:00' },
  });
  deepEqual(parseProposalEvent(ok), { pageId: 'p', blockIds: ['b'], timestamp: '2026-11-27T00:00:00.000Z' });
  const bad = [
    'nope',
    JSON.stringify({ action: 'other', client_payload: {} }),
    JSON.stringify({
      action: 'proposal-updated',
      client_payload: { page_id: '', block_ids: [], timestamp: '2026-11-27T00:00:00Z' },
    }),
    JSON.stringify({
      action: 'proposal-updated',
      client_payload: { page_id: 'p', block_ids: [1], timestamp: '2026-11-27T00:00:00Z' },
    }),
    JSON.stringify({
      action: 'proposal-updated',
      client_payload: { page_id: 'p', block_ids: [], timestamp: 'yesterday' },
    }),
  ];
  for (const text of bad) equal('error' in parseProposalEvent(text), true, text);
});

test('the first update creates the request; previous comes from the last closed one with a marker', async () => {
  const gh = gate('7');
  gh.addIssue(E2E, {
    title: 'Proposal updated',
    state: 'closed',
    labels: ['request'],
    body: stateBlock({
      earliest: '2026-11-20T00:00:00.000Z',
      latest: '2026-11-21T00:00:00.000Z',
      previous: 'none recorded',
    }),
    updated_at: '2026-11-22T00:00:00Z',
  });
  gh.addIssue(E2E, {
    title: 'Proposal updated',
    state: 'closed',
    labels: ['request'],
    body: 'hand-made, no marker',
    updated_at: '2026-11-25T00:00:00Z',
  });
  gh.addIssue(E2E, { title: 'Proposal updated: R3.55', labels: ['request'] });
  const { output, failed } = await proposalUpdated(gh, env('7'), event('2026-11-27T01:00:00.000Z'));
  equal(failed, false);
  equal(output.filed[0]?.decision, 'created');
  const created = gh.repo(E2E)[3];
  deepEqual([created?.title, created?.labels, created?.assignees], ['Proposal updated', ['request'], ['taco3064']]);
  deepEqual(readState(created?.body ?? ''), {
    earliest: '2026-11-27T01:00:00.000Z',
    latest: '2026-11-27T01:00:00.000Z',
    previous: '2026-11-21T00:00:00.000Z',
  });
  match(created?.body ?? '', /- Previous handled update: 2026-11-21T00:00:00.000Z/);
  match(created?.body ?? '', /Notion's version history \(kept 7 days on the Free plan\)/);
  match(created?.body ?? '', /```text\npage-1\nb1\nb2\n```/);
});

test('without any earlier request, previous is none recorded', async () => {
  const gh = gate('7');
  await proposalUpdated(gh, env('7'), event('2026-11-27T01:00:00.000Z'));
  equal(readState(gh.repo(E2E)[0]?.body ?? '')?.previous, 'none recorded');
});

test('a follow-up update comments and widens earliest and latest, keeping previous and the rest of the body', async () => {
  const gh = gate('7', '8', '9');
  await proposalUpdated(gh, env('7'), event('2026-11-27T05:00:00.000Z'));
  const issue = gh.repo(E2E)[0];
  if (!issue) throw new Error('not created');
  issue.body = `${issue.body}\n\nA note a person added.`;
  const later = await proposalUpdated(gh, env('8'), event('2026-11-27T07:00:00.000Z'));
  equal(later.output.filed[0]?.decision, 'commented');
  await proposalUpdated(gh, env('9'), event('2026-11-27T03:00:00.000Z'));
  deepEqual(readState(issue.body), {
    earliest: '2026-11-27T03:00:00.000Z',
    latest: '2026-11-27T07:00:00.000Z',
    previous: 'none recorded',
  });
  match(issue.body, /A note a person added\./);
  equal(issue.comments.length, 2);
  match(
    issue.comments[0]?.body ?? '',
    /^<!-- nibfin-e2e:run 8 -->\n## Another event\n\nEvent time: 2026-11-27T07:00:00.000Z/,
  );
  equal(gh.repo(E2E).length, 1);
});

test('a redo after the comment but before the PATCH skips the comment and converges the times', async () => {
  const gh = gate('7', '8');
  await proposalUpdated(gh, env('7'), event('2026-11-27T05:00:00.000Z'));
  gh.crash = { at: 'PATCH /repos/taco3064/nibfin-e2e/issues/1' };
  const crashed = await proposalUpdated(gh, env('8'), event('2026-11-27T06:00:00.000Z'));
  equal(crashed.failed, true);
  const issue = gh.repo(E2E)[0];
  equal(issue?.comments.length, 1);
  equal(readState(issue?.body ?? '')?.latest, '2026-11-27T05:00:00.000Z');
  const redo = await proposalUpdated(gh, env('8'), event('2026-11-27T06:00:00.000Z'));
  equal(redo.failed, false);
  equal(redo.output.filed[0]?.decision, 'already commented');
  equal(issue?.comments.length, 1);
  equal(readState(issue?.body ?? '')?.latest, '2026-11-27T06:00:00.000Z');
  // The run that created it, redone, writes nothing more.
  const before = gh.writes.length;
  equal(
    (await proposalUpdated(gh, env('7'), event('2026-11-27T05:00:00.000Z'))).output.filed[0]?.decision,
    'already filed',
  );
  equal(gh.writes.length, before);
});
