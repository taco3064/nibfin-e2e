import { validateMetadata } from './schema.mjs';

export function register(entries) {
  if (!Array.isArray(entries)) throw new Error('Registry must be an array');
  const seen = new Set();
  return entries.map(entry => {
    const metadata = validateMetadata(entry);
    if (seen.has(metadata.id)) throw new Error(`Duplicate scenario: ${metadata.id}`);
    seen.add(metadata.id);
    return metadata;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function select(entries, groups = []) {
  const registry = register(entries);
  if (!Array.isArray(groups) || groups.some(group => typeof group !== 'string')) {
    throw new Error('Groups must be an array of names');
  }
  const known = new Set(registry.map(entry => entry.group));
  for (const group of groups) {
    if (!known.has(group)) throw new Error(`Unknown group: ${group}`);
  }
  return registry.filter(entry => !groups.length || groups.includes(entry.group));
}
// Live scenarios are deliberately absent until implemented by their owning Issues.
export const scenarios = Object.freeze([]);
