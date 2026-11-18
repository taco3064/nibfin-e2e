import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defectPublisher } from '../defect-publisher.mjs';
import { defectKey } from '../defect-policy.mjs';

const configuration = { targets: [{ repository: 'owner/repo', id: 1 }],
  assignee: { id: 2, login: 'owner' }, label: 'scope' };
const evidence = ['source', 'callers', 'issues'].map(kind =>
  ({ id: kind, kind, text: `Public ${kind}` }));
const finding = { classification: 'implementation_defect', repository: 'owner/repo',
  behavior: 'resume', ownerSource: 'src/resume.mjs', changeIdentity: 'reconcile',
  necessaryChange: 'Reconcile before retrying.', title: 'Reconcile before retrying',
  body: 'The caller repeats a write. Reconcile the maintained journal first.',
  duplicate: 'No matching work.', evidence: evidence.map(row => row.id) };

async function harness(t, mode = 'issue-events') {
  const root = await mkdtemp(join(tmpdir(), 'operator-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issues = [];
  let creates = 0;
  const github = { validate: async () => true,
    issues: async () => ({ complete: true, issues }),
    read: async () => issues[0],
    create: async (repository, content) => {
      creates++;
      issues.push({ ...content, id: 3, number: 4, node_id: 'ISSUE_4', state: 'open',
        url: `https://api.github.com/repos/${repository}/issues/4`,
        html_url: `https://github.com/${repository}/issues/4`,
        assignees: [configuration.assignee], labels: [{ name: 'scope' }] });
      return 4;
    } };
  const options = { configuration, stateDir: join(root, 'state'),
    modelRoot: join(root, 'model'), github,
    assess: async ({ finding }) => ({ publicSafe: true, english: true,
      codeBacked: true, key: defectKey(finding), duplicate: 'none' }),
    publicationMode: mode };
  return { publish: await defectPublisher(options), options, issues, github,
    creates: () => creates };
}

test('event publication verifies URL without touching a direct wake capability',
  async t => {
    const h = await harness(t);
    const publish = await defectPublisher({ ...h.options, wake: {
      observe() { throw new Error('must not observe'); },
      request() { throw new Error('must not dispatch'); },
    } });
    const first = await publish(finding, evidence, 'controlled');
    assert.equal(first.state, 'associated');
    assert.equal(first.route, 'issue-events');
    assert.equal(first.wake, 'not-requested');
    assert.equal(first.issue.url, 'https://github.com/owner/repo/issues/4');
    assert.equal(first.wakeRunId, undefined);
    assert.deepEqual(await publish(finding, evidence, 'controlled'), first);
    assert.equal(h.creates(), 1);
    h.issues[0].state = 'closed';
    const closed = await publish(finding, evidence, 'controlled');
    assert.equal(closed.reason, 'CLOSED_WORK');
    assert.equal(closed.issue.state, 'closed');
    assert.equal(h.creates(), 1);
  });

for (const url of [undefined, 'https://github.com/attacker/repo/issues/4',
  'https://github.com/owner/repo/issues/5',
  'https://github.com/owner/repo/issues/4?token=private']) {
  test(`event publication rejects an unverified browser URL: ${url}`, async t => {
    const h = await harness(t);
    await h.publish(finding, evidence, 'controlled');
    h.issues[0].html_url = url;
    const result = await h.publish(finding, evidence, 'controlled');
    assert.equal(result.reason, 'ISSUE_URL_UNVERIFIED');
    assert.equal(result.issue, undefined);
    assert.equal(h.creates(), 1);
  });
}

test('legacy absence of wake does not implicitly opt in to Issue events', async t => {
  const h = await harness(t, undefined);
  // Omit mode entirely: legacy callers retain direct-wake reconciliation.
  const { publicationMode, ...options } = h.options;
  const publish = await defectPublisher(options);
  assert.equal((await publish(finding, evidence, 'controlled')).reason,
    'WAKE_CAPABILITY_UNAVAILABLE');
});

test('event mode retains unknown-create intent rather than publishing twice', async t => {
  const h = await harness(t);
  h.github.create = async () => null;
  assert.equal((await h.publish(finding, evidence, 'controlled')).reason,
    'CREATE_EFFECT_UNRESOLVED');
  h.github.create = () => { throw new Error('must not create again'); };
  assert.equal((await h.publish(finding, evidence, 'controlled')).reason,
    'CREATE_EFFECT_UNRESOLVED');
});
