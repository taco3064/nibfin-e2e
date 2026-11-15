import { deliveryFixture } from './delivery-support.mjs';
import { wakeFixture } from '../scenarios/wake-fixtures.mjs';

// Controlled fixture only; no live account, provider, tool or network proof.
export function pairedFixture(edit = () => {}) {
  const legs = [], events = [];
  const caller = { mode: 'fixture',
    async createFixture(definition) {
      const index = legs.length;
      const leg = { definition, issue: 29 + index, issueId: 10 + index };
      legs.push(leg);
      return { definition, lifecycle: {
        async setup() {
          return { state: 'passing', resources: [{ kind: 'issue', state: 'owned',
            native: { id: leg.issueId, number: leg.issue } }] };
        },
        async prepareDelivery(body, assignee) {
          events.push(`prepare:${index}`);
          leg.body = body; leg.assignee = assignee;
          return { state: 'passing' };
        },
        async teardown() {
          events.push(`cleanup:${index}`);
          return { state: 'passing' };
        },
      } };
    },
    async trigger(binding) {
      const index = legs.findIndex(l => l.issue === binding.issue);
      const leg = legs[index];
      leg.binding = binding;
      events.push(`trigger:${index}`);
      leg.wake = JSON.parse(JSON.stringify(wakeFixture('shared-issue',
        'completed', binding)).replaceAll('fixture/execution',
        `fixture/execution-${index}`).replaceAll('I_fixture_10',
        `I_fixture_${leg.issueId}`));
      leg.wake.evidence.issue.data.id = leg.issueId;
      return leg.wake.expected;
    },
    async readWakeEvidence(binding) {
      return legs.find(l => l.issue === binding.issue).wake.evidence;
    },
    async readDeliveryEvidence(binding) {
      const index = legs.findIndex(l => l.issue === binding.issue);
      events.push(`read:${index}`);
      const e = deliveryFixture(binding);
      e.candidate.id += `-${index}`;
      e.candidate.shape += `-${index}`;
      e.pull.number += index;
      e.pull.head = (index ? 'd' : 'b').repeat(40);
      for (const s of e.stages) {
        s.candidate = e.candidate.id;
        s.shape = e.candidate.shape;
        s.pull = e.pull.number;
        s.head = e.pull.head;
        s.execution.id += `-${index}`;
        s.execution.sessionId += `-${index}`;
      }
      edit('delivery', e, index);
      legs[index].evidence = e;
      return e;
    },
    async assertSource(binding) {
      const result = { ...binding, state: 'satisfied', exitCode: 0,
        checkout: { commit: binding.mergeCommit, clean: true } };
      edit('source', result);
      return result;
    },
    async readIsolationEvidence(binding) {
      const value = { ...binding, result: { mode: 'synthetic', state: 'synthetic',
        code: 'REJECTION_AND_RECOVERY', case: 'unauthorized-workflow',
        expected: { runnerId: binding.wake.runnerId,
          repository: binding.wake.runRepository },
        actual: { runnerId: binding.wake.runnerId,
          repository: binding.wake.runRepository } } };
      edit('isolation', value);
      return value;
    },
    async readConcurrencyEvidence(binding) {
      const admissions = legs.map(l => ({ ...l.evidence.admissions[0],
        runnerId: 400, memberId: 7 }));
      const history = { ...binding, admissions,
        coverage: { start: 0, end: 10, admissions: true, writers: true },
        writers: admissions.map((a, i) => ({ ...a,
          executionId: legs[i].evidence.stages[3].execution.id,
          start: 1, activeUntil: 9, end: 9 })), effects: 'reconciled',
        capacity: 2, independentEligible: true,
        progress: binding.issues.map(issue => ({ issue, at: 3, unfinishedUntil: 8 })) };
      edit('history', history);
      return history;
    },
    async observe(target) {
      const base = `https://api.github.com/repos/${target.repository}`;
      let data;
      if (target.kind === 'pull') {
        const leg = legs.find(l => l.evidence?.pull.number === target.number);
        data = { id: target.number, number: target.number,
          url: `${base}/pulls/${target.number}`, merged: true,
          head: { sha: leg.evidence.pull.head },
          merge_commit_sha: leg.evidence.pull.mergeCommit };
      } else if (target.kind === 'checks') {
        data = [{ id: 6, url: `${base}/check-runs/6`, head_sha: target.sha,
          status: 'completed', conclusion: 'success' }];
      } else if (target.kind === 'issue' &&
          legs.find(l => l.issue === target.number)?.evidence) {
        const leg = legs.find(l => l.issue === target.number);
        data = { id: leg.issueId, number: target.number,
          url: `${base}/issues/${target.number}`, state: 'closed',
          labels: [{ name: 'delivered' }] };
      } else {
        for (const leg of legs) {
          const found = Object.values(leg.wake?.evidence ?? {}).find(value =>
            value?.target && Object.keys(target).every(key =>
              value.target[key] === target[key]));
          if (found) return structuredClone(found);
        }
      }
      const result = { complete: true, target, data };
      edit('native', result);
      return result;
    },
  };
  return { caller, legs, events };
}
