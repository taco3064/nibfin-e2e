import { pathToFileURL } from 'node:url';
import { producerFile } from './source-producers.mjs';
import { same, stages } from './delivery-contract.mjs';

const bindingKeys = ['requestId', 'repository', 'issue'];
const recordKeys = ['stage', 'candidate', 'head', 'pull'];

// The protected extractor supplies the independently resolved Core context.
// Core alone establishes Candidate equivalence and unchanged-content review.
// This adapter does not accept a consumer-authored list of equivalent hashes.
export async function readDeliveryApplicability(core, context, binding, evidence) {
  try {
    if (!same(core, context.source, ['repository', 'commit'])) {
      return { state: 'unverified' };
    }
    const file = await producerFile(core.checkout, 'src/stages.mjs');
    const identity = await producerFile(core.checkout, 'src/identity.mjs');
    const { digest } = await import(pathToFileURL(identity).href);
    const { decideStage } = await import(pathToFileURL(file).href);
    const decision = decideStage('close', context);
    if (decision.status !== 'allowed' ||
        digest(context.candidate) !== evidence.candidate.id ||
        context.pr?.number !== evidence.pull.number ||
        context.pr?.head !== evidence.pull.head ||
        context.pr?.mergeCommit !== evidence.pull.mergeCommit ||
        context.shape?.hash !== evidence.candidate.shape ||
        JSON.stringify(context.candidate.paths) !==
          JSON.stringify(evidence.candidate.paths) ||
        context.ci?.checks.length !== evidence.pull.checkIds.length ||
        new Set(context.ci.checks.map(check => check.id)).size !==
          evidence.pull.checkIds.length ||
        !context.ci.checks.every(check => evidence.pull.checkIds.includes(check.id)) ||
        context.approval?.record.issue.number !== binding.issue ||
        context.approval.record.issue.repository !== binding.repository) {
      return { state: 'unverified' };
    }
    const names = { 'pre-accept': 'pre-accept-hooks',
      'post-accept': 'post-accept-hooks' };
    for (const record of evidence.stages.slice(3)) {
      if (record.stage === 'close') {
        if (!same(record.execution, context.execution, ['id', 'sessionId']) ||
            !same(record.admission, context.execution, ['runId', 'attempt', 'jobId']) ||
            record.candidate !== evidence.candidate.id ||
            record.head !== context.pr.head || record.pull !== context.pr.number) {
          return { state: 'unverified' };
        }
        continue;
      }
      const receipt = context.receipts[names[record.stage] ?? record.stage];
      if (!receipt ||
          !same(record.admission, receipt.execution, ['runId', 'attempt', 'jobId']) ||
          receipt.execution?.id !== record.execution?.id ||
          receipt.execution?.sessionId !== record.execution?.sessionId ||
          receipt.artifacts?.candidateHash !== record.candidate ||
          (['commit-pr', 'review-pr', 'merge'].includes(record.stage) &&
            (receipt.artifacts?.head !== record.head ||
              receipt.artifacts?.prNumber !== record.pull))) {
        return { state: 'unverified' };
      }
    }
    return { state: 'satisfied',
      binding: Object.fromEntries(bindingKeys.map(key => [key, binding[key]])),
      candidate: evidence.candidate.id, head: evidence.pull.head,
      pull: evidence.pull.number, testedSha: context.ci.testedSha,
      checkIds: [...evidence.pull.checkIds],
      stages: evidence.stages.slice(3).map(record => ({
        ...Object.fromEntries(recordKeys.map(key => [key, record[key]])),
        execution: { id: record.execution.id, sessionId: record.execution.sessionId },
        admission: Object.fromEntries(['runRepository', 'runId', 'attempt', 'jobId']
          .map(key => [key, record.admission[key]])),
      })) };
  } catch { return { state: 'unverified' }; }
}

export function applicableDelivery(binding, evidence, record) {
  if (!record || !evidence.candidate || !evidence.pull ||
      !Array.isArray(evidence.pull.checkIds)) return false;
  const proof = evidence.applicability;
  return proof?.state === 'satisfied' && same(proof.binding, binding, bindingKeys) &&
    proof.candidate === evidence.candidate.id && proof.head === evidence.pull.head &&
    proof.pull === evidence.pull.number &&
    Array.isArray(proof.checkIds) &&
    proof.checkIds.length === evidence.pull.checkIds.length &&
    new Set(proof.checkIds).size === proof.checkIds.length &&
    proof.checkIds.every(id => evidence.pull.checkIds.includes(id)) &&
    Array.isArray(proof.stages) && proof.stages.length === stages.length - 3 &&
    proof.stages.filter(item => item?.stage === record.stage).length === 1 &&
    proof.stages.some(item => same(item, record, recordKeys) &&
      same(item.execution, record.execution, ['id', 'sessionId']) &&
      same(item.admission, record.admission,
        ['runRepository', 'runId', 'attempt', 'jobId']));
}
