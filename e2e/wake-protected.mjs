import { fixtureBudget } from './fixture-budget.mjs';
import { validEnrollment } from './peer-observations.mjs';
import { correlateWake } from './wake-correlation.mjs';

// Protected library only. Neither this composition nor its callbacks are passed
// to ordinary workers. Callers own authorization and durable recovery inventory.
// readEvidence extracts observed Core/forwarding/Action records; it must never
// synthesize records from expected values or from a successful write response.
export async function observeLiveWake({ leg, expected, observe, readEvidence,
  bounds = {}, maxAttempts = 1, mode = 'live' }) {
  const unavailable = () => ({ leg, mode: mode === 'fixture' ? 'fixture' : 'live',
    state: 'unverified',
    code: 'LIVE_EVIDENCE_UNAVAILABLE' });
  try {
    const budget = fixtureBudget(bounds);
    if (!['live', 'fixture'].includes(mode) || !Number.isSafeInteger(maxAttempts) ||
        maxAttempts < 1 || maxAttempts > 10) return unavailable();
    let result = unavailable();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        native[key] = await budget.call(signal => observe(target, undefined, { signal }));
      }
      result = correlateWake(leg, expected, { ...evidence, ...native }, mode);
      if (result.state === 'passed' ||
          result.code === 'WAKE_PERMISSION_UNAVAILABLE') return result;
    }
    return result;
  } catch (error) {
    return error?.code === 'WAKE_PERMISSION_DENIED' ? { leg, mode,
      state: 'unverified', code: 'WAKE_PERMISSION_UNAVAILABLE' } : unavailable();
  }
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

// Both capabilities are fixed by the independently authorized operator. Reads
// may retry; this composition never retries enrollment or dispatches a Wake.
export async function enrollAndObserveSharedIssue({ enrollment, ...options }) {
  const unavailable = code => ({ leg: 'shared-issue', mode: 'live',
    state: 'unverified', code });
  try {
    const peer = await enrollment.enroll();
    if (!validEnrollment(peer, 'live')) return unavailable(
      peer?.disposition === 'denied' ? 'PEER_PERMISSION_UNAVAILABLE' :
        'PEER_ENROLLMENT_REQUIRED');
    return observeLiveWake({ ...options, leg: 'shared-issue', mode: 'live',
      readEvidence: async signal => ({ ...await options.readEvidence(signal),
        enrollment: peer }),
    });
  } catch { return unavailable('PEER_ENROLLMENT_REQUIRED'); }
}
