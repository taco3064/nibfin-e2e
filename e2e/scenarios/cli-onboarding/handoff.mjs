import { isDeepStrictEqual } from 'node:util';
import { sourceRepositories } from '../../source-checkout.mjs';

const repositories = Object.freeze(Object.fromEntries(
  sourceRepositories.map(source => [source.id, source.repository]),
));
const managedPaths = new Set([
  '.nibfin/producer-pins.json', '.github/workflows/nibfin-wake.yml',
  '.github/workflows/nibfin-issue.yml', '.github/workflows/nibfin-stage.yml',
]);
const unknownCodes = new Set([
  'INSTALL_TREE_RESULT_UNKNOWN', 'INSTALL_COMMIT_RESULT_UNKNOWN',
  'INSTALL_BRANCH_RESULT_UNKNOWN_READ_BACK_BEFORE_RETRY',
  'PR_RESULT_UNKNOWN_READ_BACK_BEFORE_RETRY', 'PR_READBACK_UNAVAILABLE',
  'LABEL_RESULT_UNKNOWN_READ_BACK_BEFORE_RETRY',
  'UPGRADE_TREE_UNKNOWN_READ_BACK_BEFORE_RETRY',
  'UPGRADE_COMMIT_UNKNOWN_READ_BACK_BEFORE_RETRY',
  'UPGRADE_REF_UNKNOWN_READ_BACK_BEFORE_RETRY',
  'UPGRADE_PR_UNKNOWN_READ_BACK_BEFORE_RETRY',
]);
function requireValue(valid) {
  if (!valid) throw new Error('MALFORMED_HANDOFF');
}
function record(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  requireValue([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  requireValue(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()));
}
function text(value, maximum = 256) {
  requireValue(typeof value === 'string' && value.length > 0 &&
    value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value));
}
function choice(value, options) { requireValue(options.includes(value)); }
function commit(value) {
  requireValue(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value));
}
function count(value) { requireValue(Number.isSafeInteger(value) && value >= 0); }
function branch(value) {
  text(value);
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) &&
    !value.includes('..') && !value.endsWith('/'));
}
function target(value) {
  record(value, ['repository', 'id', 'ownerType', 'defaultBranch', 'baseCommit']);
  text(value.repository);
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(value.repository));
  count(value.id);
  requireValue(value.id > 0);
  choice(value.ownerType, ['User', 'Organization']);
  branch(value.defaultBranch);
  commit(value.baseCommit);
}
function sources(value) {
  record(value, Object.keys(repositories));
  for (const [id, repository] of Object.entries(repositories)) {
    record(value[id], ['repository', 'commit']);
    requireValue(value[id].repository === repository);
    commit(value[id].commit);
  }
}
function files(value) {
  requireValue(Array.isArray(value) && value.length <= managedPaths.size);
  const seen = new Set();
  for (const file of value) {
    record(file, ['path', 'content']);
    requireValue(managedPaths.has(file.path) && !seen.has(file.path));
    requireValue(typeof file.content === 'string' && file.content.length <= 65536);
    seen.add(file.path);
  }
}
function labels(value) {
  requireValue(Array.isArray(value) && value.length <= 3);
  requireValue(new Set(value).size === value.length);
  for (const label of value) choice(label, ['scope', 'shaped', 'delivered']);
}
function binding(value) {
  text(value.scenario);
  requireValue(/^cli-onboarding\.[a-z0-9.-]+$/.test(value.scenario));
  target(value.target);
  sources(value.sources);
}
function bounded(value) {
  requireValue(JSON.stringify(value).length <= 600000);
}
export function validateRequest(value) {
  record(value, ['scenario', 'intent', 'target', 'sources', 'expected']);
  binding(value);
  choice(value.intent, [
    'init-preview', 'init-apply', 'upgrade-preview', 'upgrade-apply',
  ]);
  record(value.expected, ['status', 'head', 'files', 'labels']);
  choice(value.expected.status, ['preview', 'proposal', 'unchanged']);
  requireValue(value.intent.endsWith('preview') ? value.expected.status === 'preview' :
    value.expected.status !== 'preview');
  if (value.expected.status === 'proposal') branch(value.expected.head);
  else requireValue(value.expected.head === null);
  files(value.expected.files);
  labels(value.expected.labels);
  bounded(value);
  return value;
}
function validateObservation(value) {
  record(value, ['scenario', 'target', 'sources', 'origin', 'cli', 'provider']);
  binding(value);
  choice(value.origin, ['synthetic', 'operator']);
  record(value.cli, ['status', 'code', 'exitCode', 'pullRequest', 'files', 'labels']);
  choice(value.cli.status, ['preview', 'pending', 'completed', 'no_change', 'error']);
  requireValue(typeof value.cli.code === 'string' &&
    /^[A-Z0-9_:. -]{0,160}$/.test(value.cli.code));
  count(value.cli.exitCode);
  requireValue(value.cli.exitCode <= 255);
  if (value.cli.pullRequest !== null) text(value.cli.pullRequest);
  files(value.cli.files);
  labels(value.cli.labels);
  const provider = value.provider;
  record(provider, ['state', 'mutations', 'defaultBranchWrites', 'localEffects',
    'defaultBranchCommit',
    'merged', 'pullRequest', 'files', 'labels']);
  choice(provider.state, ['observed', 'unavailable']);
  for (const key of ['mutations', 'defaultBranchWrites', 'localEffects']) {
    if (provider.state !== 'unavailable' || provider[key] !== null) count(provider[key]);
  }
  if (provider.state !== 'unavailable' || provider.defaultBranchCommit !== null) {
    commit(provider.defaultBranchCommit);
  }
  requireValue(typeof provider.merged === 'boolean' ||
    (provider.state === 'unavailable' && provider.merged === null));
  if (provider.pullRequest !== null) {
    const pull = provider.pullRequest;
    record(pull, ['url', 'state', 'base', 'head', 'headCommit']);
    text(pull.url);
    choice(pull.state, ['open', 'closed']);
    branch(pull.base);
    branch(pull.head);
    commit(pull.headCommit);
  }
  files(provider.files);
  labels(provider.labels);
  bounded(value);
}
function canonicalFiles(value) {
  return [...value].sort((a, b) => a.path.localeCompare(b.path));
}
function sameFiles(a, b) {
  return isDeepStrictEqual(canonicalFiles(a), canonicalFiles(b));
}
function sameLabels(a, b) {
  return isDeepStrictEqual([...a].sort(), [...b].sort());
}
function matchesPull(request, pull) {
  const prefix = `https://github.com/${request.target.repository}/pull/`;
  return pull.url.startsWith(prefix) &&
    /^[1-9][0-9]*$/.test(pull.url.slice(prefix.length)) &&
    pull.state === 'open' && pull.base === request.target.defaultBranch &&
    pull.head === request.expected.head && pull.headCommit !== request.target.baseCommit;
}
function result(outcome, code) {
  return { outcome, code, protectedExecution: 'unverified' };
}

// Operator is a provenance claim, not authorization. The external protected
// receiver owns authentication, invocation and cleanup; workers receive data only.
export function compareHandoff(request, observation) {
  validateRequest(request);
  if (observation === undefined || observation === null) {
    return result('unverified', 'LIVE_OBSERVATION_MISSING');
  }
  try { validateObservation(observation); }
  catch { return result('failing', 'MALFORMED_OBSERVATION'); }
  if (['scenario', 'target', 'sources'].some(key =>
    !isDeepStrictEqual(request[key], observation[key]))) {
    return result('failing', 'OBSERVATION_BINDING_MISMATCH');
  }
  const { cli, provider } = observation;
  const expected = request.expected;
  if ((provider.defaultBranchCommit !== null &&
      provider.defaultBranchCommit !== request.target.baseCommit) || provider.merged ||
      provider.defaultBranchWrites > 0) {
    return result('failing', 'PROPOSAL_BOUNDARY_VIOLATION');
  }
  if (cli.status === 'error' || (cli.exitCode !== 0 &&
      !(cli.status === 'pending' && cli.exitCode === 2 &&
        (unknownCodes.has(cli.code) ||
         cli.code === 'INSTALLATION_PR_REQUIRES_REVIEW_AND_MERGE')))) {
    return result('failing', 'CLI_EXECUTION_FAILED');
  }
  if (!sameFiles(cli.files, expected.files) || !sameLabels(cli.labels, expected.labels)) {
    return result('failing', 'CLI_PLAN_MISMATCH');
  }
  if (expected.status === 'proposal') {
    const pull = provider.pullRequest;
    if ((provider.files.length && !sameFiles(provider.files, expected.files)) ||
        (provider.labels.length && !sameLabels(provider.labels, expected.labels)) ||
        (pull && (!matchesPull(request, pull) ||
          (cli.pullRequest !== null && cli.pullRequest !== pull.url)))) {
      return result('failing', 'PROVIDER_RESULT_MISMATCH');
    }
  }
  if (expected.status === 'preview' &&
      (cli.pullRequest !== null || provider.pullRequest !== null ||
       provider.mutations > 0 || provider.localEffects > 0)) {
    return result('failing', 'PREVIEW_SIDE_EFFECT_OR_RESULT_MISMATCH');
  }
  if (expected.status === 'unchanged' &&
      (cli.pullRequest !== null || provider.pullRequest !== null ||
       provider.mutations > 0)) {
    return result('failing', 'UNCHANGED_RESULT_MISMATCH');
  }
  if (cli.status === 'pending' && unknownCodes.has(cli.code)) {
    return result('unverified', 'EXTERNAL_EFFECT_UNRESOLVED');
  }
  const init = request.intent.startsWith('init-');
  const expectedCode = expected.status === 'preview' ? '' :
    expected.status === 'unchanged' ?
      (init ? 'INITIALIZATION_READ_BACK' : 'MANAGED_SOURCES_ALREADY_CURRENT') :
      (init ? 'INSTALLATION_PR_REQUIRES_REVIEW_AND_MERGE' :
        'UPGRADE_PR_REQUIRES_REVIEW_CI_MERGE_AND_SEPARATE_HOST_ADOPTION');
  const expectedStatus = expected.status === 'preview' ? 'preview' :
    expected.status === 'proposal' ? 'pending' : (init ? 'completed' : 'no_change');
  const expectedExit = init && expected.status === 'proposal' ? 2 : 0;
  if (cli.status !== expectedStatus || cli.code !== expectedCode ||
      cli.exitCode !== expectedExit) return result('failing', 'CLI_RESULT_MISMATCH');
  if (provider.state === 'unavailable') {
    return result('unverified', 'PROVIDER_READ_BACK_UNAVAILABLE');
  }
  if (expected.status === 'preview') {
    if (cli.status !== 'preview' || cli.pullRequest !== null ||
        provider.mutations !== 0 || provider.localEffects !== 0 ||
        provider.pullRequest !== null) {
      return result('failing', 'PREVIEW_SIDE_EFFECT_OR_RESULT_MISMATCH');
    }
  } else if (expected.status === 'unchanged') {
    if (!['completed', 'no_change'].includes(cli.status) ||
        cli.pullRequest !== null || provider.mutations !== 0 ||
        provider.pullRequest !== null) {
      return result('failing', 'UNCHANGED_RESULT_MISMATCH');
    }
  } else {
    const pull = provider.pullRequest;
    if (cli.status !== 'pending' || !pull || !matchesPull(request, pull) ||
        cli.pullRequest !== pull.url ||
        !sameFiles(provider.files, expected.files) ||
        !sameLabels(provider.labels, expected.labels)) {
      return result('failing', 'PROVIDER_RESULT_MISMATCH');
    }
  }
  return result(observation.origin === 'synthetic' ? 'unverified' : 'passed',
    observation.origin === 'synthetic' ? 'SYNTHETIC_CONTRACT_MATCHED' :
      'OPERATOR_OBSERVATIONS_MATCHED');
}
