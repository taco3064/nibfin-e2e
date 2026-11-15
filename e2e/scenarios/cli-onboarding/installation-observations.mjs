// Protected adapters supply fresh independent reads, never command receipts.
export const installationId = value => Number.isSafeInteger(value) && value > 0;
export const installationText = value => typeof value === 'string' &&
  /^[A-Za-z0-9_./:@-]{1,256}$/.test(value);
const text = value => installationText(value) ? value : null;
const id = value => installationId(value) ? value : null;
const choice = (value, values) => values.includes(value) ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const commit = value => /^[a-f0-9]{40}$/.test(value ?? '') ? value : null;
export const sourceIdentities = sources => Object.fromEntries(
  ['core', 'action', 'cli'].map(key => [key, {
    repository: text(sources?.[key]?.repository),
    commit: commit(sources?.[key]?.commit),
  }]),
);
export function sameSources(left, right) {
  return ['core', 'action', 'cli'].every(key =>
    left?.[key]?.repository === right?.[key]?.repository &&
    left?.[key]?.commit === right?.[key]?.commit);
}
export function installationObservation(value) {
  const v = value ?? {};
  const p = v.installation ?? {};
  const pull = p.pullRequest;
  return {
    binding: { owner: text(v.binding?.owner), hostId: text(v.binding?.hostId),
      repository: text(v.binding?.repository),
      repositoryId: id(v.binding?.repositoryId), memberId: id(v.binding?.memberId) },
    sources: sourceIdentities(v.sources),
    installation: {
      pullRequest: pull ? { number: id(pull.number), headCommit: commit(pull.headCommit),
        repositoryId: id(pull.repositoryId) } : null,
      checks: choice(p.checks, ['passed', 'pending', 'failed', 'not-required']),
      reviewed: bool(p.reviewed), merged: bool(p.merged),
      contentMatches: bool(p.contentMatches),
    },
    host: { ready: bool(v.host?.ready), serviceUser: text(v.host?.serviceUser),
      serviceState: choice(v.host?.serviceState, ['active', 'inactive', 'failed']) },
    endpoint: text(v.endpoint),
    registrationsComplete: bool(v.registrationsComplete),
    runnerCount: Array.isArray(v.runners) ? v.runners.length : null,
    runners: Array.isArray(v.runners) && v.runners.length <= 2 ? v.runners.map(r => ({
      id: id(r.id), name: text(r.name), memberId: id(r.memberId),
      repositoryId: id(r.repositoryId), endpoint: text(r.endpoint),
      localId: id(r.localId), localName: text(r.localName),
      shared: bool(r.shared), status: choice(r.status, ['online', 'offline']),
    })) : null,
  };
}

// Unknowns never count as confirmation. Contradictions stop before any mutation.
export function compareInstallation(binding, sources, observation, previous = []) {
  const o = observation;
  const different = (actual, expected) => actual !== null && actual !== expected;
  if (Object.keys(binding).some(key => different(o.binding[key], binding[key]))) {
    return 'binding-conflict';
  }
  for (const key of ['core', 'action', 'cli']) {
    if (['repository', 'commit'].some(field =>
      different(o.sources[key][field], sources[key][field]))) return 'source-conflict';
  }
  const endpoint = `https://github.com/${binding.repository}`;
  if (different(o.endpoint, endpoint)) return 'endpoint-conflict';
  if (o.runnerCount > 2) return 'registration-conflict';
  let unknown = o.runners === null || o.registrationsComplete !== true ||
    Object.values(o.binding).some(v => v === null) ||
    !sameSources(o.sources, sources);
  const ids = new Set();
  const names = new Set();
  for (const runner of o.runners ?? []) {
    if (different(runner.memberId, binding.memberId) ||
        different(runner.repositoryId, binding.repositoryId) ||
        different(runner.endpoint, endpoint) || runner.shared === false ||
        (runner.id !== null && different(runner.localId, runner.id)) ||
        (runner.name !== null && different(runner.localName, runner.name))) {
      return 'registration-conflict';
    }
    if (runner.id === null || runner.name === null) {
      unknown = true;
      continue;
    }
    if (ids.has(runner.id) || names.has(runner.name)) return 'registration-conflict';
    ids.add(runner.id);
    names.add(runner.name);
    if ([runner.memberId, runner.repositoryId, runner.endpoint, runner.localId,
      runner.localName, runner.shared].some(v => v === null)) unknown = true;
  }
  for (const old of previous) {
    if (o.runners?.some(r =>
      (r.id === old.id && different(r.name, old.name)) ||
      (r.name === old.name && different(r.id, old.id)))) return 'registration-conflict';
    if (o.registrationsComplete === true && o.runners?.every(r =>
      r.id !== null && r.name !== null) && !o.runners.some(r =>
      r.id === old.id && r.name === old.name)) return 'registration-conflict';
  }
  const p = o.installation;
  if (p.pullRequest?.repositoryId !== null && p.pullRequest &&
      p.pullRequest.repositoryId !== binding.repositoryId) return 'binding-conflict';
  if (p.checks === 'failed') return 'checks-failed';
  if (unknown) return 'unknown';
  if (!p.pullRequest?.number || !p.pullRequest.headCommit ||
      p.pullRequest.repositoryId !== binding.repositoryId || p.reviewed !== true ||
      p.merged !== true || p.contentMatches !== true ||
      !['passed', 'not-required'].includes(p.checks)) return 'installation-pr';
  if (o.host.ready !== true) return 'host-prerequisites';
  if (o.endpoint !== endpoint) return 'unknown';
  if (o.runners.length !== 2) return 'registration';
  if (o.host.serviceState !== 'active' || !o.host.serviceUser) return 'startup';
  if (o.runners.some(r => r.status !== 'online')) return 'online-readback';
  return 'installed';
}
