import { outcomes } from './schema.mjs';
import { identity } from './coverage-catalog.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
export function validateDocument(document, registry) {
  if (!object(document) || document.schemaVersion !== 1 ||
      !Array.isArray(document.results) || !Array.isArray(document.errors)) {
    throw new Error('Expected version-1 runner document');
  }
  const results = new Map();
  for (const item of document.results) {
    if (!object(item) || !identity(item.id) || !identity(item.group) ||
        !outcomes.includes(item.outcome) || !object(item.reason) ||
        !text(item.reason.code) || !text(item.reason.message)) {
      throw new Error('Malformed runner result');
    }
    if (results.has(item.id)) throw new Error('Duplicate runner result');
    const scenario = registry.get(item.id);
    if (!scenario) throw new Error('Unknown scenario result');
    if (scenario.group !== item.group) throw new Error('Scenario group mismatch');
    results.set(item.id, structuredClone(item));
  }
  for (const error of document.errors) {
    if (!text(error)) {
      throw new Error('Malformed runner error');
    }
  }
  return results;
}

export function safeEvidenceUrl(value) {
  if (typeof value !== 'string' || /[\s\\<>"'`]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['github.com', 'api.github.com'].includes(url.hostname) ||
        url.search || url.hash) return null;
    const repo = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
    const path = url.hostname === 'github.com'
      ? `^/${repo}/(?:issues/\\d+|pull/\\d+|actions/runs/\\d+` +
        '(?:/attempts/\\d+|/job/\\d+)?|commit/[a-fA-F0-9]{40})$'
      : `^/repos/${repo}/(?:issues/\\d+|pulls/\\d+|actions/runs/\\d+` +
        '|actions/jobs/\\d+|check-runs/\\d+|commits/[a-fA-F0-9]{40})$';
    return new RegExp(path).test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function associations(entries, results) {
  if (!Array.isArray(entries)) throw new Error('Evidence must be an array');
  const mapped = new Map();
  for (const entry of entries) {
    if (!object(entry) || !results.has(entry.scenarioId) ||
        !Array.isArray(entry.urls) ||
        (entry.exercised !== undefined && typeof entry.exercised !== 'boolean')) {
      throw new Error('Invalid evidence association');
    }
    if (mapped.has(entry.scenarioId)) throw new Error('Duplicate evidence association');
    const outcome = results.get(entry.scenarioId).outcome;
    if (entry.exercised && ['blocked', 'skipped-by-policy'].includes(outcome)) {
      throw new Error('Excluded scenario cannot be exercised');
    }
    const urls = entry.urls.map(safeEvidenceUrl);
    mapped.set(entry.scenarioId, {
      urls: [...new Set(urls.filter(Boolean))],
      rejectedUrls: urls.filter(url => url === null).length,
      exercised: entry.exercised === true,
    });
  }
  return mapped;
}
