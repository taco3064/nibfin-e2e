// Authoritative metadata and JSON result schemas; no external validator needed.
export const outcomes = Object.freeze([
  'passed', 'failing', 'skipped-by-policy', 'blocked', 'unverified',
]);
export const metadataSchema = Object.freeze({
  id: 'identifier',
  group: 'identifier',
  title: 'text',
  timeoutMs: 'timeout',
  module: 'module',
  policyReason: 'optionalText',
});
const identifier = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Scenario metadata must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(metadataSchema, key)) {
      throw new Error(`Unknown metadata field: ${key}`);
    }
  }
  for (const [key, kind] of Object.entries(metadataSchema)) {
    const item = value[key];
    if (kind === 'optionalText' && item === undefined) continue;
    let valid = typeof item === 'string' && item.trim().length > 0;
    if (kind === 'identifier') valid = valid && identifier.test(item);
    if (kind === 'timeout') {
      valid = Number.isSafeInteger(item) && item > 0 && item <= 2147483647;
    }
    if (kind === 'module') {
      try { valid = valid && new URL(item).protocol === 'file:'; }
      catch { valid = false; }
    }
    if (!valid) throw new Error(`Invalid scenario metadata: ${key}`);
  }
  return Object.freeze({ ...value });
}
export function result(scenario, outcome, code, message) {
  if (!outcomes.includes(outcome)) throw new Error('Invalid outcome');
  return {
    id: scenario.id, group: scenario.group, outcome,
    reason: { code, message },
  };
}
export function report(results, errors = []) {
  return { schemaVersion: 1, results, errors };
}
export function exitCode(document) {
  return document.errors.length || document.results.some(
    item => item.outcome !== 'passed' && item.outcome !== 'skipped-by-policy',
  ) ? 1 : 0;
}
