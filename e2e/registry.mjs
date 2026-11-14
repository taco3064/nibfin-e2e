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
// These are credential-free contract fixtures, not live-provider verification.
export const scenarios = Object.freeze(['shared-issue', 'action'].map(leg => ({
  id: `wake.${leg}.fixture`, group: 'wake-contract',
  title: `${leg} controlled correlation contract (no live verification)`,
  timeoutMs: 5000, module: new URL(`./scenarios/${leg}.mjs`, import.meta.url).href,
})));
