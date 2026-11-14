import { prepareSources } from './sources.mjs';

// Source ownership remains outside workers. Unknown native use must not race
// disposal of checkouts passed to the protected trigger.
export async function withDeliverySources(use, prepare = prepareSources) {
  const prepared = await prepare();
  const outcome = await use(prepared);
  if (outcome.cleanup === 'unresolved') return {
    ...outcome, sourceCleanup: 'deferred',
  };
  try { await prepared.dispose(); }
  catch {
    return { ...outcome, state: 'unverified', liveVerified: false,
      sourceCleanup: 'unresolved' };
  }
  return outcome;
}
