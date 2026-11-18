import { defectConfiguration, positiveId } from './defect-policy.mjs';

// Composition binds these functions to the installed authorized Core wake route
// and its native reconciliation. They are not arbitrary HTTP or workflow tools.
// E2E supplies only verified locators; Core keeps admission, routing and journal.
export function defectWake({ configuration, requestWake, reconcileWake }) {
  const config = defectConfiguration(configuration);
  if (![requestWake, reconcileWake].every(value => typeof value === 'function')) {
    throw new Error('WAKE_CAPABILITY_UNAVAILABLE');
  }
  function locator(context) {
    const target = config.targets.find(row => row.repository === context.repository);
    if (!target || !positiveId(context.number) || !positiveId(context.id) ||
        typeof context.nodeId !== 'string' || !context.nodeId) {
      throw new Error('WAKE_LOCATOR_INVALID');
    }
    return { repository: target.repository, repositoryId: target.id,
      number: context.number, id: context.nodeId };
  }
  return Object.freeze({
    async request(context) { await requestWake(locator(context)); },
    async observe(context) {
      const result = await reconcileWake(locator(context));
      // Only the trusted native journal reader can establish absence. A missing
      // response, an acknowledgement or an empty fanout never proves dispatch.
      if (result?.status === 'absent' && result.journalAbsent === true) {
        return { state: 'absent' };
      }
      if (result?.status === 'scheduled' && positiveId(result.runId) &&
          result.stageAdmitted === false) {
        return { state: 'dispatched', runId: result.runId };
      }
      if (result?.status === 'denied') return { state: 'denied' };
      if (result?.status === 'skipped' && result.code !== 'REPLAYED_OPERATION') {
        return { state: 'blocked' };
      }
      return { state: 'pending' };
    },
  });
}
