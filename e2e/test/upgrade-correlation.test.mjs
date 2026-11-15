import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeFixture } from '../scenarios/wake-fixtures.mjs';
import { correlateWake } from '../wake-correlation.mjs';
import { validateDelivery } from '../delivery-evidence.mjs';
import { deliveryFixture } from './delivery-support.mjs';
import { verifyDeliveryNative } from '../delivery-native.mjs';

const correlate = f => correlateWake('shared-issue', f.expected, f.evidence, 'fixture');
function advanced() {
  const f = wakeFixture();
  for (const record of [f.expected, f.evidence.core[0], f.evidence.wake,
    f.evidence.route, f.evidence.forwarding, f.evidence.continuity.binding]) {
    record.sourceCommit = 'e'.repeat(40);
    record.originSourceCommit = 'f'.repeat(40);
  }
  f.evidence.run.data.head_sha = f.expected.sourceCommit;
  f.evidence.origin.data.head_sha = f.expected.originSourceCommit;
  f.evidence.oidc.sourceCommit = f.expected.sourceCommit;
  return f;
}

test('native continuity permits unrelated advancement without selecting code', () => {
  const f = advanced();
  assert.equal(correlate(f).state, 'passed');
  assert.equal(f.evidence.enrollment.callers.execution.sourceCommit, 'c'.repeat(40));
  assert.equal(f.evidence.enrollment.sources.core.commit, 'b'.repeat(40));
  delete f.evidence.continuity;
  assert.equal(correlate(f).state, 'unverified');
});

test('old and new admitted source sets cannot exchange equal or reordered times', () => {
  for (const times of [[10, 10], [20, 10], [10, 20]]) {
    const old = wakeFixture();
    const next = advanced();
    const identity = { runId: 201, attempt: 1, jobId: 302, checkRunId: 303 };
    for (const record of [next.expected, next.evidence.core[0], next.evidence.wake,
      next.evidence.forwarding, next.evidence.oidc,
      next.evidence.continuity.binding]) Object.assign(record, identity);
    const base = 'https://api.github.com/repos/fixture/execution';
    Object.assign(next.evidence.run.target, { runId: 201, attempt: 1 });
    Object.assign(next.evidence.run.data, { id: 201, run_attempt: 1,
      url: `${base}/actions/runs/201` });
    Object.assign(next.evidence.jobs.target, { runId: 201, attempt: 1 });
    Object.assign(next.evidence.jobs.data[0], { id: 302, run_id: 201, run_attempt: 1,
      url: `${base}/actions/jobs/302`, check_run_url: `${base}/check-runs/303` });
    const commit = '9'.repeat(40);
    for (const record of [next.expected, next.evidence.route, next.evidence.wake]) {
      record.reusableWorkflow = `fixture/core/.github/workflows/issue.yml@${commit}`;
    }
    for (const [key, revision] of [['core', commit], ['action', '8'.repeat(40)],
      ['cli', '7'.repeat(40)]]) {
      next.evidence.enrollment.sources[key].commit = revision;
      next.evidence.continuity.sources[key].commit = revision;
    }
    old.evidence.startedAt = times[0];
    next.evidence.startedAt = times[1];
    assert.equal(correlate(old).state, 'passed');
    assert.equal(correlate(next).state, 'passed');
    [old.evidence.continuity, next.evidence.continuity] =
      [next.evidence.continuity, old.evidence.continuity];
    assert.equal(correlate(old).state, 'unverified');
    assert.equal(correlate(next).state, 'unverified');
  }
});

for (const mutate of [
  e => { e.continuity.state = 'pending'; },
  e => { e.continuity.state = 'skipped'; },
  e => { e.continuity.binding.jobId++; },
  e => { e.continuity.binding.attempt++; },
  e => { e.continuity.callers.execution.workflowId++; },
  e => { e.continuity.callers.issue.sourceCommit = 'f'.repeat(40); },
  e => { e.continuity.sources.action.commit = 'f'.repeat(40); },
  e => { delete e.continuity.callers; },
]) {
  test('incomplete or foreign continuity cannot assert success', () => {
    const f = advanced();
    mutate(f.evidence);
    assert.equal(correlate(f).state, 'unverified');
  });
}

function delivery() {
  const wake = wakeFixture().expected;
  const binding = { requestId: 'request-1', repository: wake.repository, issue: 29,
    wake, path: 'answer.mjs', content: 'console.log(42);\n' };
  return { binding, evidence: deliveryFixture(binding) };
}
function proof(binding, evidence) {
  return { state: 'satisfied', binding: { ...binding },
    candidate: evidence.candidate.id, head: evidence.pull.head,
    pull: evidence.pull.number, checkIds: [...evidence.pull.checkIds],
    stages: structuredClone(evidence.stages.slice(3)) };
}

test('only producer-established continuity permits prior Candidate and review', () => {
  const { binding, evidence } = delivery();
  evidence.stages[5].candidate = 'equivalent-candidate';
  evidence.stages[8].head = 'a'.repeat(40);
  assert.equal(validateDelivery(binding, evidence).state, 'unverified');
  evidence.equivalentCandidates = ['equivalent-candidate'];
  assert.equal(validateDelivery(binding, evidence).state, 'unverified');
  evidence.applicability = proof(binding, evidence);
  assert.equal(validateDelivery(binding, evidence).state, 'satisfied');
  evidence.candidate.id = 'substantively-changed';
  assert.equal(validateDelivery(binding, evidence).state, 'unverified');
});

test('stale or foreign producer associations cannot establish delivery', () => {
  for (const mutate of [
    e => { e.applicability.state = 'pending'; },
    e => { e.applicability.binding.requestId = 'prior'; },
    e => { e.applicability.pull++; },
    e => { e.applicability.head = 'f'.repeat(40); },
    e => { e.applicability.stages[2].execution.id = 'foreign'; },
    e => { e.applicability.stages[2].admission.jobId++; },
  ]) {
    const { binding, evidence } = delivery();
    evidence.stages[5].candidate = 'previous';
    evidence.applicability = proof(binding, evidence);
    mutate(evidence);
    assert.equal(validateDelivery(binding, evidence).state, 'unverified');
  }
});


test('native CI binds merge previews and rejects stale checks', async () => {
  for (const kind of ['preview', 'stale', 'skipped', 'foreign']) {
    const { binding, evidence } = delivery();
    evidence.applicability = proof(binding, evidence);
    const preview = 'a'.repeat(40);
    evidence.applicability.testedSha = preview;
    if (kind === 'foreign') evidence.applicability.binding.requestId = 'foreign';
    const fixture = wakeFixture();
    const reads = [];
    const observe = async target => {
      reads.push(target);
      const base = `https://api.github.com/repos/${target.repository}`;
      let data;
      if (target.kind === 'run') data = fixture.evidence.run.data;
      if (target.kind === 'jobs') data = fixture.evidence.jobs.data;
      if (target.kind === 'pull') data = { id: 5, number: target.number,
        url: `${base}/pulls/${target.number}`, merged: true,
        head: { sha: evidence.pull.head }, merge_commit_sha: evidence.pull.mergeCommit };
      if (target.kind === 'checks') data = [{ id: 6, url: `${base}/check-runs/6`,
        head_sha: kind === 'stale' ? evidence.pull.head : preview,
        status: 'completed', conclusion: kind === 'skipped' ? 'skipped' : 'success' }];
      if (target.kind === 'issue') data = { id: 10, number: target.number,
        url: `${base}/issues/${target.number}`, state: 'closed',
        labels: [{ name: 'delivered' }] };
      return { target, complete: true, data };
    };
    const actual = await verifyDeliveryNative(binding, evidence, observe);
    assert.equal(actual.state, kind === 'preview' ? 'satisfied' : 'unverified');
    const checks = reads.filter(target => target.kind === 'checks');
    assert.equal(checks.length, kind === 'foreign' ? 0 : 1);
    if (checks.length) assert.equal(checks[0].sha, preview);
  }
});
