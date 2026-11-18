import { failureObservations, investigationResult } from './defect-observations.mjs';
import { withScopeSource } from './defect-source.mjs';

// Capabilities are supplied only by trusted programmatic composition. CLI input,
// session snapshots and repository text cannot select providers or credentials.
export async function investigateFailure(report, capabilities) {
  const phase = report.requested?.phase;
  const passing = !report.reason && (phase === 'complete' ?
    report.outcome === 'passed' : report.phases?.[phase]?.state === 'passed');
  if (passing) return investigationResult('not-needed', 'REQUEST_PASSED');
  if (!capabilities?.model) {
    return investigationResult('unavailable', 'AUTHORIZED_MODEL_UNAVAILABLE');
  }
  const acquire = capabilities.scopeSource ?? withScopeSource;
  let revision = null;
  try {
    return await acquire(async source => {
      if (!/^[a-f0-9]{40}$/.test(source.revision ?? '') || !source.skill) {
        throw new Error('SCOPE_SOURCE_INVALID');
      }
      revision = source.revision;
      let findings;
      try {
        findings = await capabilities.model({ skill: source.skill, revision,
          symptoms: failureObservations(report) });
      } catch {
        return investigationResult('unresolved', 'MODEL_INVOCATION_UNRESOLVED',
          { coreRevision: revision });
      }
      const publications = [];
      if (!Array.isArray(findings?.findings) || findings.findings.length > 16 ||
          !Array.isArray(findings.evidence)) {
        return investigationResult('unresolved', 'MODEL_OUTPUT_INVALID',
          { coreRevision: revision });
      }
      for (const finding of findings.findings) {
        publications.push(capabilities.publish ? await capabilities.publish(
          finding, findings.evidence, failureObservations(report).provenance,
        ) : { state: 'not-published', reason: 'PUBLISHER_UNAVAILABLE' });
      }
      return investigationResult('investigated', findings.findings.length ?
        'FINDINGS_RECONCILED' : 'NO_CONFIRMED_DEFECT',
      { coreRevision: revision, publications });
    });
  } catch (error) {
    const reasons = ['SOURCE_TERMINATION_UNKNOWN', 'SCOPE_SKILL_UNAVAILABLE',
      'OFFICIAL_SOURCE_UNAVAILABLE', 'INVESTIGATION_UNRESOLVED'];
    if (/^[a-f0-9]{40}$/.test(error?.scopeRevision ?? '')) {
      revision = error?.scopeRevision;
    }
    if (reasons.includes(error?.investigationReason)) {
      return investigationResult('unresolved', error?.investigationReason,
        { coreRevision: revision });
    }
    return investigationResult('unresolved', revision ?
      'INVESTIGATION_UNRESOLVED' : 'OFFICIAL_SCOPE_UNAVAILABLE',
    { coreRevision: revision });
  }
}
