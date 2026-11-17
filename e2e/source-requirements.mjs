// Input names distinguish checkout identity from executable preparation.
export const fullRequirements = Object.freeze(['core', 'action', 'cli']);
export const sourceRequirements = Object.freeze([
  'core-source', 'core', 'action-source', 'action', 'cli',
]);
export function requirements(value = fullRequirements) {
  if (!Array.isArray(value) || value.some(id => !sourceRequirements.includes(id)) ||
      new Set(value).size !== value.length) {
    throw new Error('Invalid scenario source requirements');
  }
  return Object.freeze([...value]);
}
export function sourceClosure(requested) {
  const inputs = new Set(requirements(requested));
  if (inputs.has('cli')) {
    inputs.add('core');
    inputs.add('action-source');
  }
  if (inputs.has('action')) inputs.add('core');
  if (inputs.has('core')) inputs.add('core-source');
  if (inputs.has('action')) inputs.add('action-source');
  return [...inputs];
}

// A shared producer may be prepared for another scenario in the same run.
export function selectedSourceInputs(sources, requested) {
  const inputs = sourceClosure(requested);
  return Object.fromEntries(Object.entries(sources).flatMap(([id, source]) => {
    if (inputs.includes(id)) return [[id, source]];
    if (!inputs.includes(`${id}-source`)) return [];
    const { output, ...identity } = source;
    return [[id, identity]];
  }));
}
