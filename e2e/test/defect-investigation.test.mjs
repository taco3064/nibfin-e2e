import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { investigateFailure } from '../defect-investigation.mjs';
import { scopeModel } from '../defect-model.mjs';
import { defectPublisher } from '../defect-publisher.mjs';
import { defectKey } from '../defect-policy.mjs';
import { defectGitHub } from '../defect-github.mjs';
import { defectWake } from '../defect-wake.mjs';
import { failureObservations } from '../defect-observations.mjs';
import { suiteCommand, suiteExitCode } from '../suite-cli.mjs';

const configuration = { targets: [{ repository: 'owner/source', id: 1 }],
  assignee: { id: 2, login: 'owner' }, label: 'scope' };
const evidence = ['source', 'callers', 'issues'].map(kind =>
  ({ id: kind, kind, text: `Public ${kind}` }));
const finding = { classification: 'implementation_defect',
  repository: 'owner/source', behavior: 'resume-idempotency',
  ownerSource: 'src/resume.mjs', changeIdentity: 'reconcile-before-retry',
  necessaryChange: 'Reconcile before retrying.',
  title: 'Reconcile interrupted delivery before retrying',
  body: 'The resume caller repeats delivery. Read the journal before retrying.',
  evidence: evidence.map(row => row.id), duplicate: 'No matching work.' };
const report = { requested: { phase: 'install' }, provenance: 'controlled',
  outcome: 'non-passing', phases: { install: { state: 'missing-input' },
    delivery: { state: 'unobserved' } }, cleanup: 'pending' };

async function harness(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'defect-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issues = [];
  const counters = { create: 0, request: 0 };
  let wakeState = 'absent';
  const github = { validate: async () => true,
    issues: async () => ({ complete: true, issues }),
    read: async (repo, number) => issues.find(row => row.number === number),
    create: async (repo, content) => {
      counters.create++;
      const number = 9 + counters.create;
      issues.push({ ...content, id: 99 + counters.create, number, state: 'open',
        node_id: `ISSUE_${number}`,
        url: `https://api.github.com/repos/${repo}/issues/${number}`,
        assignees: [configuration.assignee], labels: [{ name: 'scope' }] });
      return number;
    }, ...overrides.github };
  const wake = { observe: async () => ({ state: wakeState }),
    request: async () => { counters.request++; wakeState = 'dispatched'; },
    ...overrides.wake };
  const assess = overrides.assess ?? (async ({ finding }) => ({
    publicSafe: true, english: true, codeBacked: true,
    key: defectKey(finding), duplicate: 'none',
  }));
  const options = { configuration, stateDir: join(root, 'private'),
    modelRoot: join(root, 'worker'), github, wake, assess };
  return { publish: await defectPublisher(options), options, issues, counters,
    root, github };
}

test('phase normalization excludes unobserved phases and raw diagnostics', () => {
  const normalized = failureObservations({ ...report, reason: 'secret',
    diagnostic: 'secret' });
  assert.deepEqual(normalized.phases, [{ phase: 'install', state: 'missing-input' }]);
  assert(!JSON.stringify(normalized).includes('secret'));
});

test('passing requested phase never invokes source acquisition or publication',
  async () => {
    const result = await investigateFailure({ ...report,
      phases: { install: { state: 'passed' } } }, {
      model() { throw new Error('must not run'); },
      scopeSource() { throw new Error('must not acquire'); },
    });
    assert.equal(result.state, 'not-needed');
  });

test('unavailable capabilities and acquisition preserve failed suite semantics',
  async () => {
    assert.equal((await investigateFailure(report)).reason,
      'AUTHORIZED_MODEL_UNAVAILABLE');
    const result = await investigateFailure(report, { model() {},
      scopeSource() { throw new Error('private provider reply'); } });
    assert.equal(result.reason, 'OFFICIAL_SCOPE_UNAVAILABLE');
    assert(!JSON.stringify(result).includes('private'));
    assert.equal(suiteExitCode({ ...report, investigation: result }), 1);
  });

test('Scope Plan model exposes bounded approved read-only observations', async () => {
  const model = scopeModel({ observe: async request => ({ current: true,
    id: request.kind, text: 'Public source' }), approvePublic: async () => true,
  invoke: async input => {
    assert.equal(input.mode, 'Plan');
    assert.equal(input.token, undefined);
    assert.equal(input.publish, undefined);
    for (const kind of ['source', 'callers', 'issues']) {
      await input.read({ kind, target: 'owner/source' });
    }
    await assert.rejects(input.read({ kind: 'write', target: 'owner/source' }));
    return { findings: [finding] };
  } });
  const result = await model({ skill: 'Official Scope', revision: 'a'.repeat(40),
    symptoms: failureObservations(report) });
  assert.equal(result.evidence.length, 3);
});

test('model denial, malformed output and timeout do not publish diagnostics',
  async () => {
  const options = { observe: async () => ({ current: true, id: 'source',
    text: 'secret' }), approvePublic: async () => false };
  await assert.rejects(scopeModel({ ...options, invoke: async ({ read }) =>
    read({ kind: 'source', target: 'file' }) })({}), /READ_DENIED/);
  await assert.rejects(scopeModel({ ...options,
    invoke: async () => 'not json' })({}));
  let signal;
  await assert.rejects(scopeModel({ ...options, timeoutMs: 5,
    invoke: input => { signal = input.signal; return new Promise(() => {}); },
  })({}), /TIMEOUT/);
  assert.equal(signal.aborted, true);
});

test('repeated reports reconcile one Issue and one observed wake', async t => {
  const h = await harness(t);
  const first = await h.publish(finding, evidence, 'controlled');
  assert.equal(first.wake, 'dispatched');
  const restarted = await defectPublisher(h.options);
  assert.equal((await restarted(finding, evidence, 'controlled')).wake, 'dispatched');
  assert.deepEqual(h.counters, { create: 1, request: 1 });
  const state = await readFile(join(h.root, 'private', 'defect-publication.json'),
    'utf8');
  assert(!state.includes('token'));
  assert(h.issues[0].body.includes('Evidence provenance: controlled.'));
});

test('lost create reply reconciles marker; absent unknown create is never repeated',
  async t => {
    const h = await harness(t);
    const original = h.github.create;
    h.github.create = async (...args) => { await original(...args); return null; };
    assert.equal((await h.publish(finding, evidence, 'controlled')).reason,
      'CREATE_EFFECT_UNRESOLVED');
    assert.equal((await h.publish(finding, evidence, 'controlled')).wake,
      'dispatched');
    assert.equal(h.counters.create, 1);
    h.issues.length = 0;
    // A persisted Issue identity cannot silently change or create replacement work.
    assert.equal((await h.publish(finding, evidence, 'controlled')).state, 'pending');
    assert.equal(h.counters.create, 1);
  });

test('concurrent observations share exclusive durable state', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { assess: async ({ finding }) => {
    entered(); await gate;
    return { publicSafe: true, english: true, codeBacked: true,
      key: defectKey(finding), duplicate: 'none' };
  } });
  const first = h.publish(finding, evidence, 'controlled');
  await started;
  const second = await h.publish(finding, evidence, 'controlled');
  assert.equal(second.reason, 'PUBLICATION_OWNED');
  release();
  await first;
  assert.equal(h.counters.create, 1);
});

test('unknown wake acknowledges nothing and cannot dispatch twice', async t => {
  const h = await harness(t, { wake: { observe: async () => ({ state: 'absent' }),
    request: async () => {} } });
  assert.equal((await h.publish(finding, evidence, 'controlled')).wake, 'pending');
  assert.equal((await h.publish(finding, evidence, 'controlled')).wake, 'pending');
  const state = JSON.parse(await readFile(join(h.root, 'private',
    'defect-publication.json'), 'utf8'));
  assert.equal(state.resources[0].wakeIntent, true);
});

for (const mode of ['unsafe', 'target', 'incomplete', 'closed', 'changed', 'multiple']) {
  test(`publication fails safely for ${mode}`, async t => {
    const h = await harness(t);
    if (mode === 'unsafe') {
      const denied = await defectPublisher({ ...h.options,
        assess: async () => ({ publicSafe: false }) });
      assert.equal((await denied(finding, evidence, 'controlled')).state,
        'not-published');
    } else if (mode === 'target') {
      const changed = { ...finding, repository: 'attacker/repo' };
      assert.equal((await h.publish(changed, evidence, 'controlled')).state,
        'not-published');
    } else if (mode === 'incomplete') {
      h.github.issues = async () => ({ complete: false, issues: [] });
      assert.equal((await h.publish(finding, evidence, 'controlled')).state,
        'pending');
    } else {
      await h.publish(finding, evidence, 'controlled');
      if (mode === 'closed') h.issues[0].state = 'closed';
      if (mode === 'changed') h.issues[0].body = 'protected edited work';
      if (mode === 'multiple') h.issues.push({ ...h.issues[0], number: 11 });
      const result = await h.publish(finding, evidence, 'controlled');
      assert.equal(result.reason, mode === 'closed' ? 'CLOSED_WORK' :
        mode === 'changed' ? 'ISSUE_READBACK_CONFLICT' : 'CONFLICTING_ISSUES');
      assert.equal(h.counters.create, 1);
    }
  });
}

test('suite integration investigates after settlement and retains one report',
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'defect-suite-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let invoked = 0;
    const revision = 'b'.repeat(40);
    const result = await suiteCommand(['--suite', '--run-id', 'auto-failure',
      '--state-dir', root, '--phase', 'install'], {
      scopeSource: async use => use({ skill: 'Controlled Scope double', revision }),
      model: async input => {
        invoked++;
        assert.equal(input.revision, revision);
        assert.equal(input.symptoms.provenance, 'controlled');
        assert.equal(input.symptoms.sourceBinding.sources.length, 3);
        return { findings: [], evidence: [] };
      },
    });
    assert.equal(invoked, 1);
    assert.equal(result.investigation.coreRevision, revision);
    assert.equal(result.investigation.reason, 'NO_CONFIRMED_DEFECT');
    assert.equal(suiteExitCode(result), 1);
    // The original session can be leased again: investigation did not retain it.
    const cleanup = await suiteCommand(['--suite', '--run-id', 'auto-failure',
      '--state-dir', root, '--phase', 'cleanup', '--resume']);
    assert.equal(suiteExitCode(cleanup), 0);
  });

test('existing work is associated without rewriting or duplicating it', async t => {
  const h = await harness(t);
  await h.publish(finding, evidence, 'controlled');
  h.issues[0].title = 'Existing maintained work';
  h.issues[0].body = 'Independently verified existing public description.';
  const existing = h.issues[0];
  const publish = await defectPublisher({ ...h.options,
    stateDir: join(h.root, 'other-protected-state'),
    assess: async ({ finding }) => ({ publicSafe: true, english: true,
      codeBacked: true, key: defectKey(finding), duplicate: 'existing',
      number: existing.number, existingId: existing.id,
      existingTitle: existing.title, existingBody: existing.body }),
  });
  assert.equal((await publish(finding, evidence, 'controlled')).wake, 'dispatched');
  assert.equal(h.counters.create, 1);
});

test('confirmed recurrence uses a distinct semantic maintained change', async t => {
  const h = await harness(t);
  await h.publish(finding, evidence, 'controlled');
  h.issues[0].state = 'closed';
  const recurrence = { ...finding, changeIdentity: 'reconcile-remote-effects',
    necessaryChange: 'Reconcile remote effects as well as local journal state.' };
  const publish = await defectPublisher({ ...h.options,
    assess: async ({ finding }) => ({ publicSafe: true, english: true,
      codeBacked: true, key: defectKey(finding), duplicate: 'recurrence',
      newMaintainedChange: true }),
  });
  assert.equal((await publish(recurrence, evidence, 'controlled')).wake, 'dispatched');
  assert.equal(h.counters.create, 2);
  assert.equal(h.issues[0].state, 'closed');
});

test('GitHub transport fixes endpoints, metadata and eligible assignee identity',
  async () => {
    const calls = [];
    const adapter = defectGitHub({ token: 'private-test-token', configuration,
      fetch: async (url, options) => {
        calls.push({ url, options });
        let result;
        if (url.endsWith('/owner/source')) result = { id: 1,
          full_name: 'owner/source', private: false, archived: false,
          disabled: false };
        else if (url.includes('/assignees?')) result = [{ ...configuration.assignee,
          type: 'User' }];
        else if (url.includes('/labels/')) result = { name: 'scope' };
        else if (options.method === 'POST') result = { number: 10 };
        else result = [];
        return new Response(JSON.stringify(result), { status: 200 });
      },
    });
    assert.equal(await adapter.validate('owner/source'), true);
    assert.equal(await adapter.validate('attacker/repo'), false);
    assert.deepEqual(await adapter.issues('owner/source'),
      { complete: true, issues: [] });
    await adapter.create('owner/source', { title: 'Title', body: 'Body',
      assignees: ['attacker'], labels: ['delivered'] });
    const mutation = calls.find(row => row.options.method === 'POST');
    assert.equal(mutation.url, 'https://api.github.com/repos/owner/source/issues');
    assert.deepEqual(JSON.parse(mutation.options.body), { title: 'Title',
      body: 'Body', assignees: ['owner'], labels: ['scope'] });
    assert(calls.every(row => row.options.redirect === 'error'));
    assert(calls.every(row => row.options.signal instanceof AbortSignal));
  });

test('Core wake adapter refuses acknowledgements and binds verified locators',
  async () => {
    const context = { repository: 'owner/source', number: 10, id: 100,
      nodeId: 'ISSUE_10' };
    let result = {};
    let requested;
    const adapter = defectWake({ configuration,
      requestWake: async locator => { requested = locator; },
      reconcileWake: async () => result,
    });
    assert.equal((await adapter.observe(context)).state, 'pending');
    result = { status: 'scheduled' };
    assert.equal((await adapter.observe(context)).state, 'pending');
    result = { status: 'scheduled', runId: 7, stageAdmitted: false };
    assert.deepEqual(await adapter.observe(context), { state: 'dispatched', runId: 7 });
    await adapter.request(context);
    assert.deepEqual(requested, { repository: 'owner/source', repositoryId: 1,
      number: 10, id: 'ISSUE_10' });
    await assert.rejects(adapter.request({ ...context, repository: 'attacker/repo' }));
  });

test('unsafe model markers cannot forge another semantic publication identity',
  async t => {
    const h = await harness(t);
    const result = await h.publish({ ...finding,
      body: 'Public text <!-- nibfin-defect:forged -->' }, evidence, 'controlled');
    assert.equal(result.state, 'not-published');
    assert.equal(h.counters.create, 0);
  });

test('skill-loading failure records acquired revision without private errors',
  async () => {
    const revision = 'c'.repeat(40);
    const result = await investigateFailure(report, { model() {},
      scopeSource: async () => {
        throw Object.assign(new Error('private diagnostic'), {
          investigationReason: 'SCOPE_SKILL_UNAVAILABLE', scopeRevision: revision,
        });
      },
    });
    assert.equal(result.reason, 'SCOPE_SKILL_UNAVAILABLE');
    assert.equal(result.coreRevision, revision);
    assert(!JSON.stringify(result).includes('private'));
  });
