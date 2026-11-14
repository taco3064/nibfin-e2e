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
// Wake entries are controlled fixtures; delivery requires protected capabilities.
const wake = ['shared-issue', 'action'].map(leg => ({
  id: `wake.${leg}.fixture`, group: 'wake-contract',
  title: `${leg} controlled correlation contract (no live verification)`,
  timeoutMs: 5000, module: new URL(`./scenarios/${leg}.mjs`, import.meta.url).href,
}));
const isolation = (id, group, title, module) => ({
  id, group, title, timeoutMs: 30000,
  module: new URL(`./scenarios/${module}.mjs`, import.meta.url).href,
});
export const scenarios = Object.freeze([
  ...wake,
  isolation('concurrency.fixture', 'concurrency-contract',
    'Synthetic concurrency and recovery contracts', 'concurrency-local'),
  isolation('concurrency.live', 'concurrency',
    'Protected concurrency and interrupted Runner observations', 'concurrency-live'),
  {
    id: 'pause.recovery.fixture', group: 'pause',
    title: 'Controlled actual Core pause and bounded recovery contracts',
    timeoutMs: 40000,
    module: new URL('./scenarios/pause-recovery.mjs', import.meta.url).href,
  },
  {
    id: 'pause.live', group: 'pause',
    title: 'Protected owned Issue pause and lawful resume', timeoutMs: 5000,
    module: new URL('./scenarios/pause-live.mjs', import.meta.url).href,
  },
  isolation('project-configuration.local', 'project-configuration',
    'Local target Job and role Skill contracts (no live verification)',
    'project-configuration'),
  {
    id: 'dependency.live', group: 'dependency',
    title: 'Native dependency admission and protected downstream continuation',
    timeoutMs: 5000,
    module: new URL('./scenarios/dependency.mjs', import.meta.url).href,
  },
  {
    id: 'delivery.live', group: 'delivery',
    title: 'Fresh protected Issue-to-closure delivery', timeoutMs: 5000,
    module: new URL('./scenarios/delivery.mjs', import.meta.url).href,
  },
  Object.freeze({
    id: 'cli-onboarding.contract', group: 'cli-onboarding',
    title: 'Actual CLI onboarding with synthetic provider observations',
    timeoutMs: 180000,
    module: new URL('./scenarios/cli-onboarding/contract.mjs', import.meta.url).href,
  }),
  isolation('isolation.local', 'isolation.local',
    'Synthetic Runner binding and isolation policy contracts', 'isolation-local'),
  ...['host-path', 'credential', 'role-write', 'network'].map(boundary =>
    isolation(`isolation.host.${boundary}`, 'isolation.host',
      `Authorized host ${boundary} rejection (requires protected probes)`,
      'isolation-host')),
  {
    id: 'cli.runner-contract', group: 'runner',
    title: 'Controlled actual CLI Runner lifecycle and host preflight',
    timeoutMs: 90000,
    module: new URL('./runner-scenario.mjs', import.meta.url).href,
  },
]);
