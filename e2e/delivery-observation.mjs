import { observeLiveWake } from './wake-protected.mjs';
import { same } from './delivery-contract.mjs';
import { validateDelivery } from './delivery-evidence.mjs';
import { verifyDeliveryNative } from './delivery-native.mjs';

// Shared single/paired terminal observation. No lifecycle or publication authority.
export async function finishDelivery(binding, caller, call, bounds, capture) {
  const mode = caller.mode;
  const output = (state, code) => ({ state, code, mode, liveVerified: false });
  let phase;
  let outcome;
  const wake = binding.wake;
  try {
    phase = 'WAKE_UNAVAILABLE';
    const observed = await observeLiveWake({
      leg: 'shared-issue', expected: wake, mode,
      observe: (target, _, options) => call(signal => caller.observe(target,
        AbortSignal.any([signal, options.signal]))),
      readEvidence: signal => caller.readWakeEvidence({ ...binding }, signal),
      bounds });
    if (observed.state !== 'passed') throw new Error();
    phase = 'STAGES_UNAVAILABLE';
    const evidence = await call(signal =>
      caller.readDeliveryEvidence(structuredClone(binding), signal));
    const chain = validateDelivery(binding, evidence);
    if (chain.state === 'satisfied') capture?.(evidence);
    outcome = output(chain.state, chain.code);
    if (chain.state === 'satisfied') {
      phase = 'NATIVE_DELIVERY_UNAVAILABLE';
      const native = await verifyDeliveryNative(binding, evidence,
        target => call(signal => caller.observe(target, signal)));
      if (native.state !== 'satisfied') {
        outcome = output(native.state, native.code);
      } else {
        phase = 'SOURCE_ASSERTION_UNAVAILABLE';
        const source = await call(signal => caller.assertSource({ ...binding,
          head: evidence.pull.head, mergeCommit: evidence.pull.mergeCommit }, signal));
        if (source?.state === 'contradicted') {
          outcome = output('failed', 'SOURCE_BEHAVIOR_FAILED');
        } else if (source?.state !== 'satisfied') {
          throw new Error();
        } else if (binding.stdout !== undefined &&
            (source?.stdout !== binding.stdout || source.exitCode !== 0 ||
              source.checkout?.commit !== evidence.pull.mergeCommit ||
              source.checkout?.clean !== true)) {
          outcome = output('failed', 'SOURCE_BEHAVIOR_FAILED');
        } else if (!same(source, { ...binding, head: evidence.pull.head,
              mergeCommit: evidence.pull.mergeCommit },
            ['requestId', 'repository', 'issue', 'path', 'content', 'head',
              'mergeCommit'])) {
          throw new Error();
        } else outcome = { ...output('passed', mode === 'fixture'
          ? 'FIXTURE_CONTRACT_CONFIRMED' : 'LIVE_DELIVERY_OBSERVED'),
        liveVerified: mode === 'live' };
      }
    }
  } catch { return output('unverified', phase); }
  return outcome;
}
