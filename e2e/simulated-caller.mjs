import { wakeFixture } from './scenarios/wake-fixtures.mjs';
import { deliveryFixture } from './simulated-delivery-observation.mjs';
import { javascriptRequests } from './delivery-pair.mjs';
import { simulatedSourceAssertion } from './simulated-local.mjs';

const clone = value => structuredClone(value);

export function simulatedCaller(provider, repository, legs = []) {
  const offset = provider.executions.size;
  const peer = provider.definition.repositories.find(name => name !== repository);
  const issueLeg = binding => {
    provider.authorize('observe', binding.repository);
    const leg = legs.find(row => row.issue === binding.issue &&
      row.definition.repository === binding.repository);
    if (!leg) throw new Error('SIM_RESOURCE_UNKNOWN');
    return leg;
  };
  const persistWake = leg => {
    for (const value of Object.values(leg.wake.evidence)) {
      if (value?.target) provider.store(value.target, value.data);
    }
  };
  const persistDelivery = leg => {
    const e = leg.evidence;
    const base = `https://api.github.com/repos/${repository}`;
    provider.store({ kind: 'pull', repository, number: e.pull.number }, {
      id: e.pull.number, number: e.pull.number,
      url: `${base}/pulls/${e.pull.number}`, merged: true,
      head: { sha: e.pull.head }, merge_commit_sha: e.pull.mergeCommit,
    });
    provider.store({ kind: 'checks', repository, sha: e.pull.head }, [{
      id: e.pull.checkIds[0],
      url: `${base}/check-runs/${e.pull.checkIds[0]}`, head_sha: e.pull.head,
      status: 'completed', conclusion: 'success',
    }]);
    const target = { kind: 'issue', repository, number: leg.issue };
    const issue = provider.observe(target).data;
    provider.store(target, { ...issue, state: 'closed',
      labels: [{ name: 'delivered' }] });
  };
  const caller = { mode: 'fixture',
    async createFixture(definition) {
      return provider.perform('fixture', definition.repository, () => {
        if (definition.repository !== repository) {
          throw new Error('SIM_RESOURCE_UNRELATED');
        }
        const index = legs.length;
        const leg = { definition, issue: 29 + offset + index,
          issueId: 10 + offset + index,
          ledger: {}, removed: false, prepared: false };
        legs.push(leg);
        return { definition, inventory: {
          async exclusive(action) { return action(leg.ledger, async () => {}); },
        }, lifecycle: {
          async setup() {
            provider.repository(repository);
            leg.created = true;
            return { state: 'passing', resources: [{ kind: 'issue', state: 'owned',
              native: { id: leg.issueId, number: leg.issue } }] };
          },
          async prepareDelivery(body, assignee) {
            return provider.perform('prepare', repository, () => {
              if (!leg.created || assignee.id !== provider.definition.account.id) {
                throw new Error('SIM_OPERATION_DENIED');
              }
              leg.prepared = true;
              leg.assignee = clone(assignee);
              return { state: 'passing' };
            });
          },
          async teardown() {
            if (!provider.settled) throw new Error('SIM_EFFECTS_UNKNOWN');
            leg.removed = true;
            return { state: 'passing' };
          },
        } };
      });
    },
    async trigger(binding) {
      return provider.perform('trigger', binding.repository, () => {
        const leg = issueLeg(binding);
        const row = provider.requirePublic(repository);
        if (!row.installed || !leg.prepared || leg.removed || leg.wake) {
          throw new Error('SIM_DISPATCH_PREREQUISITE');
        }
        const program = javascriptRequests.find(item =>
          binding.path === `${leg.definition.generatedRoot}${item.path}`);
        if (!program || program.content !== binding.content ||
            program.stdout !== binding.stdout) throw new Error('SIM_PROGRAM_DENIED');
        leg.binding = clone(binding);
        const index = legs.indexOf(leg);
        let text = JSON.stringify(wakeFixture('shared-issue', 'completed', binding))
          .replaceAll('fixture/execution', peer)
          .replaceAll('I_fixture_10', `I_fixture_${leg.issueId}`);
        for (const id of [100, 200, 300, 301]) {
          text = text.replace(new RegExp(`\\b${id}\\b`, 'g'),
            String(id + (index + offset) * 1000));
        }
        leg.wake = JSON.parse(text);
        leg.wake.evidence.issue.data.id = leg.issueId;
        leg.wake.expected.repositoryId = provider.repository(repository).native.id;
        leg.wake.expected.runRepositoryId = provider.repository(peer).native.id;
        // Fixtures use the two shared slots from the installed provider host.
        persistWake(leg);
        const e = deliveryFixture({ ...binding, wake: leg.wake.expected });
        e.candidate.id += `-${index + offset}`;
        e.candidate.shape += `-${index + offset}`;
        e.pull.number += index + offset;
        const suffix = (index + offset).toString(16).padStart(4, '0');
        e.pull.head = 'b'.repeat(36) + suffix;
        e.pull.mergeCommit = 'c'.repeat(36) + suffix;
        e.pull.checkIds = [6 + index + offset];
        for (const stage of e.stages) {
          Object.assign(stage, { candidate: e.candidate.id, shape: e.candidate.shape,
            pull: e.pull.number, head: e.pull.head });
          stage.execution.id += `-${index + offset}`;
          stage.execution.sessionId += `-${index + offset}`;
        }
        leg.evidence = e;
        leg.merged = { commit: e.pull.mergeCommit, content: program.content };
        provider.executions.set(`${repository}/${leg.issue}`, leg);
        persistDelivery(leg);
        return clone(leg.wake.expected);
      });
    },
    async readWakeEvidence(binding) { return clone(issueLeg(binding).wake.evidence); },
    async readDeliveryEvidence(binding) { return clone(issueLeg(binding).evidence); },
    async assertSource(binding, signal) {
      return simulatedSourceAssertion(provider, issueLeg(binding), binding, signal);
    },
    async readIsolationEvidence(binding) {
      provider.authorize('observe', binding.repository);
      // A denied operation is exercised, then the original authority still works.
      let rejected = false;
      try { provider.authorize('trigger', repository, -1); }
      catch (error) { rejected = error.message === 'SIM_OPERATION_DENIED'; }
      return { ...binding, result: { mode: 'synthetic', state: 'synthetic',
        code: rejected ? 'REJECTION_AND_RECOVERY' : 'UNVERIFIED',
        case: 'unauthorized-workflow', expected: { runnerId: binding.wake.runnerId,
          repository: binding.wake.runRepository },
        actual: { runnerId: binding.wake.runnerId,
          repository: binding.wake.runRepository } } };
    },
    async readConcurrencyEvidence(binding) {
      provider.authorize('observe', binding.repository);
      const admissions = legs.map(leg => ({ ...leg.evidence.admissions[0],
        memberId: provider.definition.account.id }));
      return { ...binding, admissions,
        coverage: { start: 0, end: 10, admissions: true, writers: true },
        writers: admissions.map((admission, index) => ({ ...admission,
          executionId: legs[index].evidence.stages[3].execution.id,
          start: 1, activeUntil: 9, end: 9 })), effects: provider.effects,
        capacity: provider.sharedRegistrations(repository).length,
        independentEligible: true,
        progress: binding.issues.map(issue => ({ issue, at: 3, unfinishedUntil: 8 })) };
    },
    async observe(target) { return provider.observe(target); },
  };
  return { caller, legs, persistWake, persistDelivery, issueLeg };
}
