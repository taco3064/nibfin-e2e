export const observationCases = Object.freeze([
  'zero', 'one', 'two', 'four', 'busy', 'running', 'stage', 'offline',
  'queued', 'paused', 'blocked', 'unknown', 'stale', 'collision', 'dedup',
]);
export const diagnosisCases = Object.freeze([
  'confirmed', 'attributed', 'missing', 'denied', 'capacity', 'unavailable',
  'stale-report',
]);
export const nativeCases = Object.freeze([
  'TestE2EDashboardOverview', 'TestE2EDashboardDiagnosis',
  'TestE2EDashboardPause', 'TestE2EDashboardArguments',
]);
export const browserCases = Object.freeze([
  'diagnosis and same-Issue actions', 'selection cannot redirect review',
  'stream reconnect preserves selection',
]);
