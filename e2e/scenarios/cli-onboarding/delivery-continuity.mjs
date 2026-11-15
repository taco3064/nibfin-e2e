import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { producerFile } from '../../source-producers.mjs';
import { stages } from '../../delivery-contract.mjs';
import { validateDelivery } from '../../delivery-evidence.mjs';
import { readDeliveryApplicability } from '../../delivery-applicability.mjs';

export const deliveryCases = ['current', 'equivalent', 'changed', 'stale-review',
  'stale-ci', 'foreign-pr', 'merge-preview', 'foreign-preview'];

// Producer-owned synthetic contexts exercise actual Core association rules.
// This never creates receipts for protected work or duplicates fixture lifecycle.
export async function exerciseDeliveryContinuity(core) {
  const load = async path => import(pathToFileURL(
    await producerFile(core.checkout, path)).href);
  const { stageFixture } = await load('test/stage-fixture.mjs');
  const { digest } = await load('src/identity.mjs');
  const { evidenceBinding } = await load('src/stages.mjs');
  const passed = [];
  for (const kind of deliveryCases) {
    const context = stageFixture('close');
    context.approval.record.validFrom = new Date(Date.now() - 60000).toISOString();
    context.approval.record.expiresAt = new Date(Date.now() + 60000).toISOString();
    Object.assign(context.source, { repository: core.repository, commit: core.commit });
    const receipts = context.receipts;
    for (const receipt of Object.values(receipts)) {
      receipt.binding = evidenceBinding(context);
    }
    const original = digest(context.candidate);
    if (['equivalent', 'changed'].includes(kind)) {
      context.candidate.diffHash = '9'.repeat(64);
      const current = digest(context.candidate);
      if (kind === 'equivalent') context.equivalentCandidates = [original];
      for (const name of ['deliver', 'commit-pr', 'merge']) {
        receipts[name].artifacts.candidateHash = current;
      }
    }
    if (kind === 'equivalent') {
      context.pr.publishedHead = context.pr.head;
      context.pr.head = '7'.repeat(40);
      context.ci.head = context.pr.head;
      context.ci.testedSha = context.pr.head;
      context.ci.checks[0].testedSha = context.pr.head;
      receipts.merge.artifacts.head = context.pr.head;
      receipts.merge.artifacts.ciHash = digest(context.ci);
    }
    if (kind === 'stale-review') {
      receipts['review-pr'].artifacts.candidateHash = 'f'.repeat(64);
    }
    if (kind === 'stale-ci') context.ci.head = 'f'.repeat(40);
    if (kind === 'foreign-pr') context.ci.prId = 'PR_foreign';
    if (['merge-preview', 'foreign-preview'].includes(kind)) {
      context.ci.testedSha = context.pr.mergePreview;
      context.ci.parents = [context.pr.base, context.pr.head];
      if (kind === 'foreign-preview') context.ci.parents.reverse();
      context.ci.checks[0].testedSha = context.ci.testedSha;
      receipts.merge.artifacts.ciHash = digest(context.ci);
      // Content review remains bound to its original independently observed CI.
    }
    const wake = { runRepository: 'example/execution', runId: 1, attempt: 1, jobId: 2 };
    const binding = { requestId: 'synthetic-upgrade', repository: 'example/core',
      issue: 2, wake, path: context.candidate.paths[0], content: 'console.log(42);\n' };
    const admission = { ...wake, ...binding };
    const candidate = { ...binding, id: digest(context.candidate),
      shape: context.shape.hash, paths: [binding.path], substantive: true,
      hooks: [], artifacts: [] };
    const names = { 'pre-accept': 'pre-accept-hooks',
      'post-accept': 'post-accept-hooks' };
    const evidence = { admissions: [admission], candidate,
      pull: { number: context.pr.number, head: context.pr.head,
        mergeCommit: context.pr.mergeCommit, checkIds: [10] },
      stages: stages.map(stage => {
        const receipt = receipts[names[stage] ?? stage];
        return { ...binding, stage, admission, outcome: 'success',
          agentExecuted: true, runnerExecuted: true, shape: context.shape.hash,
          candidate: receipt?.artifacts.candidateHash ?? candidate.id,
          head: receipt?.artifacts.head ?? context.pr.head, pull: context.pr.number,
          execution: receipt?.execution ?? context.execution, hooks: [] };
      }) };
    evidence.applicability = await readDeliveryApplicability(core, context,
      binding, evidence);
    const valid = ['current', 'equivalent', 'merge-preview'].includes(kind);
    assert.equal(evidence.applicability.state, valid ? 'satisfied' : 'unverified', kind);
    if (valid) assert.equal(validateDelivery(binding, evidence).state, 'satisfied', kind);
    passed.push(kind);
  }
  return { evidence: 'synthetic', passed };
}
