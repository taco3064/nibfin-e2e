import { positiveId, defectConfiguration } from './defect-policy.mjs';

// This adapter has no fixture deletion or release operations. Its credential is
// never returned, logged or included in the model's capability graph.
export function defectGitHub({ token, configuration,
  fetch: request = globalThis.fetch }) {
  const config = defectConfiguration(configuration);
  if (typeof token !== 'string' || !token || typeof request !== 'function') {
    throw new Error('DEFECT_TRANSPORT_CONFIGURATION');
  }
  async function call(method, repository, path = '', body) {
    if (!config.targets.some(row => row.repository === repository)) return null;
    try {
      const response = await request(
        `https://api.github.com/repos/${repository}${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      if (!response.ok || !response.body) return null;
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 2 * 1024 * 1024) return null;
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return null; }
  }
  return Object.freeze({
    async validate(repository) {
      const target = config.targets.find(row => row.repository === repository);
      if (!target) return false;
      const repo = await call('GET', repository);
      let assignee;
      for (let page = 1; page <= 100; page++) {
        const rows = await call('GET', repository,
          `/assignees?per_page=100&page=${page}`);
        if (!Array.isArray(rows)) return false;
        assignee = rows.find(row => row.id === config.assignee.id &&
          row.login === config.assignee.login && row.type === 'User');
        if (assignee || rows.length < 100) break;
      }
      const label = await call('GET', repository,
        `/labels/${encodeURIComponent(config.label)}`);
      return repo?.id === target.id && repo.full_name === repository &&
        repo.private === false && repo.archived === false &&
        repo.disabled === false && assignee?.id === config.assignee.id &&
        assignee.login === config.assignee.login && label?.name === config.label;
    },
    // Enumerating all Issues avoids search-index absence being treated as proof.
    // Both open and closed records participate; PRs are excluded.
    async issues(repository) {
      const issues = [];
      for (let page = 1; page <= 100; page++) {
        const rows = await call('GET', repository,
          `/issues?state=all&per_page=100&page=${page}`);
        if (!Array.isArray(rows)) return { complete: false, issues: [] };
        issues.push(...rows.filter(row => !row.pull_request));
        if (rows.length < 100) return { complete: true, issues };
      }
      return { complete: false, issues: [] };
    },
    async read(repository, number) {
      return positiveId(number) ? call('GET', repository, `/issues/${number}`) : null;
    },
    async create(repository, content) {
      const result = await call('POST', repository, '/issues', {
        title: content.title, body: content.body,
        assignees: [config.assignee.login], labels: [config.label],
      });
      return positiveId(result?.number) ? result.number : null;
    },
  });
}
