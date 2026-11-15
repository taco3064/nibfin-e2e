import { compareInstallation, installationObservation } from
  './scenarios/cli-onboarding/installation-observations.mjs';

// Comparison never confers authorization or protected-execution readiness.
export function compareInstallationResult(result) {
  const answer = (outcome, code) => ({ outcome, code,
    protectedExecution: 'unverified' });
  if (!result || !['synthetic', 'operator'].includes(result.origin)) {
    return answer('unverified', 'INSTALLATION_OBSERVATION_REQUIRED');
  }
  if (['contradiction', 'denied'].includes(result.disposition)) {
    return answer('failing', 'INSTALLATION_REFUSED');
  }
  if (result.disposition !== 'success') {
    return answer('unverified', 'INSTALLATION_INCOMPLETE');
  }
  try {
    const observed = installationObservation(result.observation);
    if (result.inventory?.pending || result.inventory?.runners?.length !== 2 ||
        compareInstallation(result.binding, result.sources, observed,
          result.inventory.runners) !== 'installed') {
      return answer('failing', 'INSTALLATION_RESULT_CONFLICT');
    }
  } catch { return answer('failing', 'INSTALLATION_RESULT_CONFLICT'); }
  return result.origin === 'synthetic' ?
    answer('unverified', 'SYNTHETIC_INSTALLATION_MATCHED') :
    answer('passed', 'INSTALLATION_OBSERVED');
}

const last = observation => observation?.results?.at(-1);
const state = observation => last(observation)?.record?.state;
const commands = item => item.observations;
const capability = (item, name) => last(commands(item).at(-1))?.checks?.find(
  check => check.name === name,
);

export function verifyRunnerContract(document) {
  if (document?.evidence !== 'controlled' || document.repository !== 'example/project' ||
      document.memberId !== 9 || document.protectedExecution !== 'unverified') {
    return false;
  }
  const expected = ['registered', 'remove', 'denied', 'repository', 'label',
    'unknown', 'runtime', 'member', 'busy', 'active', 'service', 'mismatched', 'tools',
    'docker', 'package'];
  if (document.cases?.length !== expected.length ||
      new Set(document.cases.map(item => item.case)).size !== expected.length) {
    return false;
  }
  for (const name of expected) {
    const item = document.cases.find(value => value.case === name);
    if (!item) return false;
    const observations = commands(item);
    const [created, registered, listed] = observations;
    const preflight = observations.at(-1);
    if (created.exit !== 0 || state(created) !== 'created' ||
        created.localConfiguration || created.native.length || created.writes ||
        created.hostCalls || created.results[0]?.status !== 'preview' ||
        preflight.command !== 'preflight' || preflight.exit !== 2 ||
        last(preflight)?.protected_execution !== 'unverified' ||
        capability(item, 'core_isolation')?.status !== 'unverified') return false;
    for (const tool of ['gh', 'git', 'node', 'codex']) {
      if (capability(item, tool)?.status !==
          (name === 'tools' ? 'unverified' : 'available')) return false;
    }
    if (capability(item, 'codex_auth')?.status !==
        (name === 'tools' ? 'unverified' : 'observed')) return false;
    if (name === 'denied' || name === 'member') {
      if (registered.exit !== 1 || registered.writes || registered.hostCalls ||
          registered.localConfiguration ||
          (name === 'denied' && listed.exit !== 1)) return false;
      continue;
    }
    if (name === 'runtime') {
      if (registered.exit === 0 || registered.hostCalls || registered.writes ||
          capability(item, 'official_runner')?.status === 'available') return false;
      continue;
    }
    if (['repository', 'label', 'unknown'].includes(name)) {
      if (registered.exit !== 2 || state(registered) !== 'registration-pending') {
        return false;
      }
      if (name === 'unknown' && (observations[3].exit === 0 ||
          observations[3].hostCalls !== 1 || observations[3].writes !== 1)) return false;
      continue;
    }
    const record = last(registered)?.record;
    const native = registered.native[0];
    if (registered.exit !== 0 || record?.state !== 'registered' ||
        record.repository !== document.repository || record.repository_id !== 7 ||
        record.member_id !== document.memberId || record.runner_id !== native?.id ||
        record.name !== native?.name || !registered.localConfiguration ||
        registered.localIdentity?.agentId !== native.id ||
        registered.localIdentity?.agentName !== native.name ||
        registered.localIdentity?.gitHubUrl !==
          `https://github.com/${document.repository}` ||
        !native.labels?.some(label => label.name === 'nibfin-user-9') ||
        listed.exit !== 0 || last(listed)?.runners?.[0]?.id !== native.id) return false;
    if (name === 'registered' || name === 'remove') {
      const cleanup = observations.at(-2);
      if (cleanup.exit !== 0 || state(cleanup) !== 'created' ||
          cleanup.localConfiguration || cleanup.native.length) return false;
      if (name === 'remove' && (state(observations[3]) !==
          'remote-removed-local-config-retained' ||
          !observations[3].localConfiguration || observations[3].native.length)) {
        return false;
      }
    }
    if (['busy', 'active', 'service', 'mismatched'].includes(name)) {
      const cleanup = observations[3];
      if (cleanup.exit === 0 || !cleanup.localConfiguration ||
          cleanup.native.length !== 1 || cleanup.hostCalls !== registered.hostCalls ||
          cleanup.writes !== registered.writes) return false;
    }
    if (!['tools', 'docker'].includes(name) &&
        capability(item, 'docker_backend')?.status !== 'observed') return false;
    if (!['tools', 'package'].includes(name) &&
        capability(item, 'official_runner')?.status !== 'available') return false;
    const missing = { tools: 'gh', docker: 'docker_backend',
      package: 'official_runner' }[name];
    if (missing && !['unverified', 'unavailable'].includes(
      capability(item, missing)?.status,
    )) return false;
  }
  return true;
}
