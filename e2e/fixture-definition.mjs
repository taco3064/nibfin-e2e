import { randomUUID } from 'node:crypto';

export const defaultTarget = 'taco3064/nibfin-e2e';
export const operations = Object.freeze({
  issue: Object.freeze({ setup: 'create-issue', teardown: 'close-issue' }),
  branch: Object.freeze({ setup: 'create-branch', teardown: 'delete-branch' }),
  pull: Object.freeze({ setup: 'create-pull', teardown: 'close-pull' }),
});
const segment = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export function fixtureDefinition(scenario, repository = defaultTarget) {
  if (!segment.test(scenario) ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid fixture');
  const owner = randomUUID();
  return Object.freeze({
    scenario, repository, owner,
    marker: `<!-- nibfin-fixture:${owner} -->`,
    name: `nibfin-fixture/${scenario}/${owner}`,
    generatedRoot: `fixtures/generated/${owner}/`,
  });
}
export function generatedPath(definition, path) {
  return typeof path === 'string' && path.startsWith(definition.generatedRoot) &&
    path.length > definition.generatedRoot.length &&
    !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
}
export function setupPayload(definition, kind, input = {}) {
  const title = `[nibfin fixture] ${definition.scenario}`;
  const body = `${definition.marker}\nControlled delivery fixture.\n` +
    `Generated changes are limited to ${definition.generatedRoot}`;
  if (kind === 'issue') return { title, body };
  if (kind === 'branch') {
    if (!/^[a-f0-9]{40}$/.test(input.sha ?? '')) throw new Error('Invalid base');
    return { ref: `refs/heads/${definition.name}`, sha: input.sha };
  }
  if (kind === 'pull') {
    if (!/^[\w./-]{1,200}$/.test(input.base ?? '')) throw new Error('Invalid base');
    return { title, body, head: definition.name, base: input.base };
  }
  throw new Error('Unsupported fixture resource');
}
