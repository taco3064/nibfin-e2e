import { deliveryFixture } from '../simulated-delivery-observation.mjs';
import { wakeFixture } from '../scenarios/wake-fixtures.mjs';
export { deliveryFixture };

export function protectedFixture(mutate = () => {}) {
  let wake;
  let binding;
  let evidence;
  let cleanups = 0;
  let setups = 0;
  const caller = {
    mode: 'fixture',
    async createFixture(definition) {
      return { definition, lifecycle: {
        async setup() {
          setups++;
          return { state: 'passing', resources: [{ kind: 'issue', state: 'owned',
            native: { id: 10, number: 29 } }] };
        },
        async mutateIssue() { return { state: 'passing' }; },
        async teardown() { cleanups++; return { state: 'passing' }; },
      } };
    },
    async trigger(value) {
      binding = value;
      wake = wakeFixture('shared-issue', 'completed', value);
      return wake.expected;
    },
    async readWakeEvidence() { return wake.evidence; },
    async readDeliveryEvidence(value) {
      evidence = deliveryFixture(value);
      mutate(evidence);
      return evidence;
    },
    async assertSource(value) { return { ...value, state: 'satisfied' }; },
    async observe(target) {
      const { kind, repository, number } = target;
      const base = `https://api.github.com/repos/${repository}`;
      let data;
      if (kind === 'pull') data = { id: 5, number, url: `${base}/pulls/${number}`,
        merged: true, head: { sha: evidence.pull.head },
        merge_commit_sha: evidence.pull.mergeCommit };
      else if (kind === 'checks') data = [{ id: 6, url: `${base}/check-runs/6`,
        head_sha: target.sha, status: 'completed', conclusion: 'success' }];
      else if (kind === 'issue' && evidence) data = { id: 10, number,
        url: `${base}/issues/${number}`, state: 'closed',
        labels: [{ name: 'delivered' }] };
      else {
        const found = Object.values(wake.evidence).find(value =>
          value?.target && Object.keys(target).every(key =>
            value.target[key] === target[key]));
        return structuredClone(found);
      }
      return { complete: true, target, data };
    },
  };
  return { caller, counts: () => ({ setups, cleanups }), binding: () => binding };
}
