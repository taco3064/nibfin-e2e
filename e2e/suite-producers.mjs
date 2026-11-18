import { runDeliveryPairPrepared } from './delivery-pair.mjs';
import { runFaultLifecyclePrepared } from './fault-lifecycle.mjs';

function adapter(specification, producer, provenance) {
  return {
    provenance,
    async execute(context) {
      // Protected open binds the caller's existing dispatch/recovery records to
      // context.intent. It must checkpoint native execution before further work.
      // No run request can supply this factory or select an executable module.
      const opened = await specification.open(context);
      const expected = provenance === 'native' ? 'live' : 'fixture';
      if (opened?.caller?.mode !== expected) {
        return { state: 'unresolved', code: 'PROVENANCE_MISMATCH', resources: [] };
      }
      const result = await producer(specification.request, opened.caller,
        context.prepared, specification.bounds);
      return { state: result.state === 'passed' &&
        result.liveVerified === (provenance === 'native') &&
        result.cleanup !== 'unresolved' ? 'passed' : 'unresolved',
      code: result.code, fixtures: result.fixtures ?? [],
      resources: opened.resources ?? [] };
    },
    // Never reenter a fresh producer when a previous dispatch may have happened.
    reconcile: specification.reconcile,
  };
}

// Consume existing producers with the suite's original source owner. Additional
// protected continuity/pressure observations can be composed in open/reconcile;
// their provenance and native validation remain with those maintained drivers.
export function suiteProducers({ delivery, failure, provenance = 'controlled' }) {
  if (!['native', 'controlled'].includes(provenance) ||
      [delivery, failure].some(spec => typeof spec?.open !== 'function' ||
        typeof spec?.reconcile !== 'function')) {
    throw new Error('SUITE_PRODUCER_CAPABILITIES_REQUIRED');
  }
  return {
    delivery: adapter(delivery, runDeliveryPairPrepared, provenance),
    failure: adapter(failure, runFaultLifecyclePrepared, provenance),
  };
}
