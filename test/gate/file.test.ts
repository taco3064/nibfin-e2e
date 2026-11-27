import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { fence, fileSubject, filingContext } from '../../src/gate/file.ts';
import { FakeGate } from './fake.ts';

const E2E = 'taco3064/nibfin-e2e';
const SINCE = '2026-11-27T09:00:00Z';
const subject = { title: 'Scenario failed: a', body: 'body text', comment: 'comment text' };

test('fence is longer than any backtick run inside', () => {
  equal(fence('plain'), '```text\nplain\n```');
  equal(fence('a ```` b'), '`````text\na ```` b\n`````');
});

test('creates the request with label and Owner assignee in one call and reads it back', async () => {
  const gh = new FakeGate();
  gh.addIssue(E2E, { title: 'Scenario failed: a', state: 'closed', labels: ['request'] });
  gh.addIssue(E2E, { title: 'Scenario failed: a', labels: ['other'] });
  const ctx = await filingContext(gh, '42', SINCE);
  const f = await fileSubject(ctx, subject);
  equal(f.decision, 'created');
  equal(f.number, 3);
  deepEqual(gh.writes, ['POST /repos/taco3064/nibfin-e2e/issues']);
  const issue = gh.repo(E2E)[2];
  deepEqual([issue?.labels, issue?.assignees], [['request'], ['taco3064']]);
  equal(issue?.body, '<!-- nibfin-e2e:run 42 -->\nbody text');
});

test('reuses the lowest-numbered open request with the same title by one comment per run', async () => {
  const gh = new FakeGate();
  gh.addIssue(E2E, { title: 'Scenario failed: a', labels: ['request'], assignees: ['taco3064'] });
  gh.addIssue(E2E, { title: 'Scenario failed: a', labels: ['request'], assignees: ['taco3064'] });
  const first = await fileSubject(await filingContext(gh, '42', SINCE), subject);
  equal(first.decision, 'commented');
  equal(first.number, 1);
  equal(gh.repo(E2E)[0]?.comments[0]?.body, '<!-- nibfin-e2e:run 42 -->\ncomment text');
  // A re-run attempt of the same run finds its comment since the run start.
  const again = await fileSubject(await filingContext(gh, '42', SINCE), subject);
  equal(again.decision, 'already commented');
  equal(gh.repo(E2E)[0]?.comments.length, 1);
  match(gh.reads.find((r) => r.includes('/comments')) ?? '', /since=2026-11-27T09%3A00%3A00Z/);
  // A later run comments again.
  equal((await fileSubject(await filingContext(gh, '43', SINCE), subject)).decision, 'commented');
  equal(gh.repo(E2E)[0]?.comments.length, 2);
});

test('a redo after a crash before read-back recognizes its own request', async () => {
  const gh = new FakeGate();
  gh.crash = { at: 'GET /repos/taco3064/nibfin-e2e/issues/1' };
  const crashed = await fileSubject(await filingContext(gh, '42', SINCE), subject);
  equal(crashed.decision, 'failed');
  match(crashed.reason, /simulated crash/);
  const redo = await fileSubject(await filingContext(gh, '42', SINCE), subject);
  equal(redo.decision, 'already filed');
  equal(gh.repo(E2E).length, 1);
  equal(gh.repo(E2E)[0]?.comments.length, 0);
});

test('a request closed while this run commented is replaced by a new one', async () => {
  const gh = new FakeGate();
  const open = gh.addIssue(E2E, { title: 'Scenario failed: a', labels: ['request'], assignees: ['taco3064'] });
  gh.afterWrite = (method, path) => {
    if (method === 'POST' && path.endsWith('/issues/1/comments')) open.state = 'closed';
  };
  const f = await fileSubject(await filingContext(gh, '42', SINCE), subject);
  equal(f.decision, 'created');
  equal(f.number, 2);
  match(f.reason, /#1 was closed/);
});

test('a read-back mismatch is a failed decision, never a silent success', async () => {
  for (const drop of [{ labels: true }, { assignees: true }]) {
    const gh = new FakeGate();
    gh.dropOnCreate = drop;
    const f = await fileSubject(await filingContext(gh, '42', SINCE), subject);
    equal(f.decision, 'failed');
    match(f.reason, drop.labels ? /label request is missing/ : /taco3064 is not assigned/);
  }
});
