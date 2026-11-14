// Intended behaviors, not a declaration of implemented or passing live scenarios.
export const products = Object.freeze(['Core', 'Action', 'CLI']);
export const catalog = Object.freeze([
  { id: 'core.delivery', product: 'Core', category: 'delivery', scenarioIds: [] },
  { id: 'action.invocation', product: 'Action', category: 'integration',
    scenarioIds: [] },
  { id: 'cli.invocation', product: 'CLI', category: 'integration', scenarioIds: [] },
].map(item => Object.freeze({ ...item, scenarioIds: Object.freeze(item.scenarioIds) })));

export function identity(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);
}
export function validateCatalog(entries) {
  if (!Array.isArray(entries)) throw new Error('Catalog must be an array');
  const seen = new Set();
  return entries.map(item => {
    if (!item || !identity(item.id) || !identity(item.category) ||
        !products.includes(item.product) || !Array.isArray(item.scenarioIds) ||
        item.scenarioIds.some(id => !identity(id))) {
      throw new Error('Invalid catalog identity or association');
    }
    if (seen.has(item.id)) throw new Error('Duplicate behavior identity');
    seen.add(item.id);
    if (new Set(item.scenarioIds).size !== item.scenarioIds.length) {
      throw new Error('Duplicate scenario association');
    }
    return { id: item.id, product: item.product, category: item.category,
      scenarioIds: [...item.scenarioIds].sort() };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
