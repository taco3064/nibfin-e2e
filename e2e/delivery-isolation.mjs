import { admissionCases } from './isolation-contract.mjs';
import { same } from './delivery-contract.mjs';

// Consume the protected #90 producer's completed rejection/recovery result.
// The reader retains the producer's underlying native observations for recovery;
// Issue text and ordinary workers cannot provide this callback or provenance.
export function deliveryIsolation(binding, evidence, mode) {
  if (!same(evidence, binding, ['repository', 'issue', 'requestId'])) return false;
  const result = evidence.result;
  const provenance = mode === 'live' ? 'live' : 'synthetic';
  const state = mode === 'live' ? 'passed' : 'synthetic';
  return result?.mode === provenance && result.state === state &&
    result.code === 'REJECTION_AND_RECOVERY' && admissionCases.includes(result.case) &&
    result.expected?.runnerId === binding.wake.runnerId &&
    result.actual?.runnerId === binding.wake.runnerId &&
    result.expected?.repository === binding.wake.runRepository &&
    result.actual?.repository === binding.wake.runRepository;
}
