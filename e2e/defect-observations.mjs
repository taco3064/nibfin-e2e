import { suitePhases, suiteSources } from './suite-result.mjs';

// Symptoms carry no arbitrary diagnostic text, paths, resource IDs or credentials.
// Investigation source observations are acquired separately from recovery sources.
export function failureObservations(report) {
  const requested = report.requested?.phase;
  const names = requested === 'complete' ? suitePhases :
    suitePhases.includes(requested) ? [requested] : [];
  let sources = [];
  try {
    if (report.sources?.length === 3) sources = suiteSources(Object.fromEntries(
      report.sources.map(source => [source.id, source])));
  } catch { /* Invalid recovery identities cannot become investigation inputs. */ }
  return { provenance: report.provenance === 'native' ? 'native' : 'controlled',
    request: requested === 'complete' ? 'complete' : names[0] ?? 'invalid',
    requestFailure: Boolean(report.reason),
    phases: names.flatMap(phase => {
      const state = report.phases?.[phase]?.state;
      return ['failed', 'unresolved', 'missing-input'].includes(state) ?
        [{ phase, state }] : [];
    }),
    // Recovery identity stays in the suite report; it never selects model inputs.
    sourceBinding: { origin: 'suite-report', sources },
  };
}

export const investigationResult = (state, reason, extra = {}) => ({
  state, reason, coreRevision: null, publications: [], ...extra,
});
