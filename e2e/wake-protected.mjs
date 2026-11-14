import { fixtureBudget } from './fixture-budget.mjs';
import { correlateWake } from './wake-correlation.mjs';

// Protected library only. Neither this composition nor its callbacks are passed
// to ordinary workers. Callers own authorization and durable recovery inventory.
// readEvidence extracts observed Core/forwarding/Action records; it must never
// synthesize records from expected values or from a successful write response.
export async function observeLiveWake({ leg, expected, observe, readEvidence,
  bounds = {} }) {
  const unavailable = () => ({ leg, mode: 'live', state: 'unverified',
    code: 'LIVE_EVIDENCE_UNAVAILABLE' });
  try {
    const budget = fixtureBudget(bounds);
    const evidence = await budget.call(signal => readEvidence(signal));
    const native = {};
    const targets = {
      issue: { kind: 'issue', repository: expected.repository,
        number: expected.issue },
      run: { kind: 'run', repository: expected.runRepository,
        runId: expected.runId, attempt: expected.attempt },
      jobs: { kind: 'jobs', repository: expected.runRepository,
        runId: expected.runId, attempt: expected.attempt },
    };
    if (leg === 'shared-issue') targets.origin = { kind: 'run',
      repository: expected.repository, runId: expected.originRunId,
      attempt: expected.originAttempt };
    for (const [key, target] of Object.entries(targets)) {
      native[key] = await budget.call(() => observe(target));
    }
    return correlateWake(leg, expected, { ...evidence, ...native }, 'live');
  } catch { return unavailable(); }
}

export async function mutateAndObserveIssue({ lifecycle, operation, input,
  expected, ...observation }) {
  const mutation = await lifecycle.mutateIssue(operation, input, {
    repository: expected.repository, number: expected.issue,
  });
  if (mutation.state !== 'passing') return {
    leg: 'shared-issue', mode: 'live', state: 'unverified',
    code: 'ISSUE_MUTATION_UNCONFIRMED',
  };
  // Event observation is separate from successful mutation/read-back.
  return observeLiveWake({ ...observation, expected, leg: 'shared-issue' });
}
