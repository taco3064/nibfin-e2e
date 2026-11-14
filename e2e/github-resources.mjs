const integer = value => Number.isSafeInteger(value) && value > 0;
export function resource(target) {
  const { repository, kind, number, runId, attempt, sha } = target;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error('Explicit owner/repository required');
  }
  const base = `https://api.github.com/repos/${repository}`;
  if (['issue', 'pull'].includes(kind) && integer(number)) {
    return { url: `${base}/${kind === 'issue' ? 'issues' : 'pulls'}/${number}` };
  }
  if (['blocked_by', 'blocking'].includes(kind) && integer(number)) {
    return { url: `${base}/issues/${number}/dependencies/${kind}?per_page=100`,
      collection: 'array' };
  }
  if (kind === 'run' && integer(runId)) {
    return { url: `${base}/actions/runs/${runId}` };
  }
  if (kind === 'jobs' && integer(runId) && integer(attempt)) {
    return {
      url: `${base}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
      collection: 'jobs',
    };
  }
  if (kind === 'checks' && /^[a-f\d]{40}$/i.test(sha ?? '')) {
    return { url: `${base}/commits/${sha}/check-runs?per_page=100`,
      collection: 'check_runs' };
  }
  throw new Error('Invalid resource identity');
}
export function matches(item, target) {
  if (!item || typeof item !== 'object' || !integer(item.id)) return false;
  const base = `https://api.github.com/repos/${target.repository}`;
  if (target.kind === 'issue' || target.kind === 'pull') {
    const path = target.kind === 'issue' ? 'issues' : 'pulls';
    return item.number === target.number &&
      item.url === `${base}/${path}/${target.number}` &&
      (target.kind !== 'issue' || !item.pull_request);
  }
  if (['blocked_by', 'blocking'].includes(target.kind)) {
    return integer(item.number) && !item.pull_request &&
      item.url === `${base}/issues/${item.number}`;
  }
  if (target.kind === 'run') {
    return item.id === target.runId &&
      item.url === `${base}/actions/runs/${target.runId}` &&
      item.repository?.full_name === target.repository &&
      (target.attempt === undefined || item.run_attempt === target.attempt) &&
      (target.sha === undefined || item.head_sha === target.sha);
  }
  if (target.kind === 'jobs') {
    return item.url === `${base}/actions/jobs/${item.id}` &&
      item.run_id === target.runId && item.run_attempt === target.attempt &&
      (target.sha === undefined || item.head_sha === target.sha);
  }
  return item.url === `${base}/check-runs/${item.id}` && item.head_sha === target.sha;
}
