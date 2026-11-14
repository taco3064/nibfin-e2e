import { sourceRepositories } from './source-checkout.mjs';

const text = value => typeof value === 'string' && value.trim() === value &&
  value.length > 0;
const object = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value);
const fail = message => { throw new Error(message); };
const exactKeys = (value, keys) => object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const invocationKeys = ['repository', 'workflow', 'environment', 'actor',
  'runId', 'attempt', 'event', 'ref'];

export function validateVersion(inputs) {
  if (!Array.isArray(inputs) || inputs.length !== 1 || !text(inputs[0])) {
    fail('VERSION: exactly one version is required');
  }
  const number = '(?:0|[1-9][0-9]*)';
  const pre = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  const pattern = `^${number}\\.${number}\\.${number}` +
    `(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`;
  if (!new RegExp(pattern).test(inputs[0])) fail('VERSION: invalid semantic version');
  return inputs[0];
}

/** @typedef {{repository: string, workflow: string, environment: string,
 * actor: string, runId: string, attempt: string, event: 'workflow_dispatch',
 * ref: 'refs/heads/main'}} InvocationIdentity */
export function validateInvocation(value, expected) {
  if (!object(value) || value.authorized !== true ||
      value.event !== 'workflow_dispatch' || value.ref !== 'refs/heads/main') {
    fail('AUTHORIZATION: protected manual invocation required');
  }
  const keys = ['repository', 'workflow', 'environment', 'actor', 'runId', 'attempt'];
  if (keys.some(key => !text(value[key]))) fail('AUTHORIZATION: invalid identity');
  if (['repository', 'workflow', 'environment'].some(key =>
    value[key] !== expected[key])) fail('AUTHORIZATION: invocation mismatch');
  return Object.fromEntries([...keys, 'event', 'ref'].map(key => [key, value[key]]));
}

export function validateConflicts(observations, version) {
  if (!Array.isArray(observations) ||
      observations.length !== sourceRepositories.length) fail('CONFLICTS: incomplete');
  for (const { repository } of sourceRepositories) {
    const rows = observations.filter(row => row?.repository === repository);
    const row = rows[0];
    if (rows.length !== 1 || row.version !== version || row.complete !== true ||
        !Array.isArray(row.tags) || !Array.isArray(row.releases) ||
        !Array.isArray(row.activePublications) ||
        [...row.tags, ...row.releases, ...row.activePublications].some(name =>
          !text(name))) {
      fail('CONFLICTS: invalid or unavailable observation');
    }
    // Observer returns all matching tags/releases, including v-prefixed aliases.
    if (row.tags.length || row.releases.length) fail('CONFLICTS: version exists');
    if (row.activePublications.length) fail('CONFLICTS: publication active');
  }
}

export function validateRemoteMains(observations, identities) {
  if (!Array.isArray(observations) || observations.length !== identities.length) {
    fail('REMOTE_MAIN: incomplete observation');
  }
  for (const source of identities) {
    const rows = observations.filter(row => row?.repository === source.repository);
    const row = rows[0];
    if (rows.length !== 1 || row.complete !== true || row.ref !== source.ref ||
        !/^[a-f0-9]{40}$/.test(row.commit ?? '')) {
      fail('REMOTE_MAIN: invalid or unavailable observation');
    }
    if (row.commit !== source.commit) fail('REMOTE_MAIN: acquired main changed');
  }
}

export function sourceIdentities(sources) {
  if (!object(sources) || Object.keys(sources).length !== 3) {
    fail('SOURCES: incomplete source set');
  }
  return sourceRepositories.map(({ id, repository, ref }) => {
    const source = sources[id];
    if (!source || source.id !== id || source.repository !== repository ||
        source.ref !== ref || !/^[a-f0-9]{40}$/.test(source.commit)) {
      fail('SOURCES: invalid current-main identity');
    }
    return { id, repository, ref, commit: source.commit };
  });
}

/** @typedef {{id: 'core'|'action'|'cli', repository: string,
 * ref: 'refs/heads/main', commit: string}} SourceIdentity */

/** @typedef {{schemaVersion: 1, mode: 'production'|'contract-test',
 * version: string, invocation: InvocationIdentity, sources: SourceIdentity[],
 * mandatory: {outcome: 'passed', scenarioIds: string[]},
 * resources: 'disposed'}} CoordinatorHandoff
 * Identity-only output: no checkout paths or credentials survive disposal.
 */
export function validateHandoff(value) {
  const keys = ['schemaVersion', 'mode', 'version', 'invocation', 'sources',
    'mandatory', 'resources'];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1 ||
      !['production', 'contract-test'].includes(value.mode) ||
      value.resources !== 'disposed') fail('HANDOFF: invalid envelope');
  validateVersion([value.version]);
  validateInvocation({ ...value.invocation, authorized: true }, value.invocation);
  if (!exactKeys(value.invocation, invocationKeys)) {
    fail('HANDOFF: unexpected invocation fields');
  }
  if (!Array.isArray(value.sources) || value.sources.length !== 3) {
    fail('HANDOFF: invalid sources');
  }
  const sources = Object.fromEntries(value.sources.map(source => [source.id, source]));
  sourceIdentities(sources);
  if (value.sources.some(source =>
    !exactKeys(source, ['id', 'repository', 'ref', 'commit']))) {
    fail('HANDOFF: unexpected source fields');
  }
  const mandatory = value.mandatory;
  if (!object(mandatory) || Object.keys(mandatory).length !== 2 ||
      mandatory.outcome !== 'passed' || !Array.isArray(mandatory.scenarioIds) ||
      !mandatory.scenarioIds.length || mandatory.scenarioIds.some(id =>
        typeof id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) ||
      new Set(mandatory.scenarioIds).size !== mandatory.scenarioIds.length) {
    fail('HANDOFF: invalid mandatory outcome');
  }
  return value;
}
