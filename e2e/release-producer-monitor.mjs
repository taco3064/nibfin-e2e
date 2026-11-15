import { sourceTerminationUnknown } from './source-process.mjs';

// Producers deliberately reduce provider errors to bounded outcomes. Keep the
// independent source owner's view of in-flight calls and unknown termination,
// including calls still alive after a producer's request deadline expires.
export function releaseProducerMonitor() {
  let active = 0;
  let unknown = false;
  const assertSettled = () => {
    if (active || unknown) {
      throw Object.assign(new Error('NATIVE_COVERAGE: producer unsettled'),
        { terminationUnknown: true });
    }
  };
  return {
    assertSettled,
    wrap(callback) {
      return async (...args) => {
        active++;
        try { return await callback(...args); }
        catch (error) {
          unknown ||= sourceTerminationUnknown(error);
          throw error;
        } finally { active--; }
      };
    },
    async run(action) {
      try { return await action(); }
      finally { assertSettled(); }
    },
  };
}
