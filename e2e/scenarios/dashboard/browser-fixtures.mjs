import { diagnosisFixture } from './overview-fixtures.mjs';

export function fixture() {
  const value = diagnosisFixture();
  const row = value.overviews[0].issues.items[0];
  const collision = structuredClone(row);
  collision.key = '2:I_foreign';
  collision.node_id = 'I_foreign';
  collision.identity = { ...collision.identity,
    repository: { id: 2, name: 'other/project', url: 'https://github.com/other/project' },
    url: 'https://github.com/other/project/issues/1' };
  collision.title = 'Collision without evidence';
  collision.evidence = [];
  for (const view of value.overviews) view.issues.items.push(structuredClone(collision));
  const report = row.evidence[0].diagnosis.reports[0];
  report.producer = 'core-native';
  report.confidence = 'observed';
  report.summary = 'Core retained a bounded native observation.';
  report.confirmed = ['EXACT_CONTAINER_OOM'];
  report.rootCause = 'The selected process exhausted its memory allocation.';
  value.overviews[1].issues.items[0].evidence[0].diagnosis =
    structuredClone(row.evidence[0].diagnosis);
  value.diagnosis_results = ['insufficient-evidence', 'denied', 'no-capacity',
    'unavailable', 'unresolved-effect'].map(status => ({ schemaVersion: 1, status,
    code: 'DIAGNOSIS_UNAVAILABLE', executionAuthority: false }));
  return value;
}
