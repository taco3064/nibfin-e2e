import { stages } from './delivery-contract.mjs';

// Synthetic observations only. No native or protected-host verification.
export function deliveryFixture(binding) {
  const admission = { ...binding.wake, requestId: binding.requestId,
    repository: binding.repository, issue: binding.issue };
  const head = 'b'.repeat(40);
  const candidate = { ...binding, id: 'candidate-1', shape: 'shape-1',
    paths: [binding.path], substantive: true, artifacts: [],
    hooks: [{ path: 'hooks/check', event: 'pre-commit' },
      { path: 'hooks/message', event: 'commit-msg' }] };
  return { admissions: [admission], candidate,
    pull: { number: 5, head, mergeCommit: 'c'.repeat(40), checkIds: [6] },
    stages: stages.map((stage, index) => ({ ...binding, stage, outcome: 'success',
      admission, execution: { id: `execution-${index}`, sessionId: `session-${index}` },
      agentExecuted: true, runnerExecuted: true, shape: 'shape-1',
      candidate: candidate.id, head, pull: 5,
      hooks: candidate.hooks.filter(hook => stage === 'pre-accept'
        ? hook.event === 'pre-commit' : stage === 'post-accept'
          ? hook.event !== 'pre-commit' : false).map(hook => ({ ...hook,
        executed: true, outcome: 'success' })),
    })) };
}
