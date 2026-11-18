import { defectGitHub } from './defect-github.mjs';
import { issueContext } from './issue-context.mjs';
import { operatorJson } from './operator-http.mjs';

export function operatorEvidence(config, request = fetch) {
  const publicGitHub = signal => defectGitHub({
    configuration: config.configuration, publicRead: true,
    fetch: (url, options) => request(url, { ...options,
      signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal }),
  });
  const approved = new WeakSet();
  const routes = config.evidence.map(row => ({ ...row,
    target: `${row.repository}/${row.path}` }));
  const requests = [...routes.map(({ kind, target }) => ({ kind, target })),
    ...config.configuration.targets.map(row => ({ kind: 'issues',
      target: row.repository }))];
  const observe = async ({ kind, target, signal }) => {
    let text;
    if (kind === 'issues') {
      const github = publicGitHub(signal);
      if (!config.configuration.targets.some(row => row.repository === target) ||
          !await github.validate(target)) throw new Error('OPERATOR_TARGET');
      const result = await github.issues(target);
      if (!result.complete) throw new Error('OPERATOR_ISSUES_INCOMPLETE');
      text = JSON.stringify({ repository: target, complete: true,
        inventoryOnly: true, duplicateAbsenceEstablished: false,
        issues: result.issues.map(row => issueContext(row, target)) });
    } else {
      const route = routes.find(row => row.kind === kind && row.target === target);
      if (!route) throw new Error('OPERATOR_EVIDENCE_DENIED');
      const base = `https://api.github.com/repos/${route.repository}`;
      const repo = await operatorJson(base, { request, signal });
      const expected = config.configuration.targets.find(row =>
        row.repository === route.repository);
      if (repo.id !== expected.id || repo.full_name !== expected.repository ||
          repo.private !== false || repo.archived || repo.disabled ||
          typeof repo.default_branch !== 'string') throw new Error('OPERATOR_TARGET');
      const branch = encodeURIComponent(repo.default_branch);
      const commit = await operatorJson(`${base}/commits/${branch}`, { request, signal });
      if (!/^[a-f0-9]{40}$/.test(commit.sha ?? '')) throw new Error('OPERATOR_REVISION');
      const file = await operatorJson(`${base}/contents/${route.path}?ref=${commit.sha}`,
        { request, signal });
      if (file.type !== 'file' || file.path !== route.path ||
          file.encoding !== 'base64' || file.size > 14000 ||
          typeof file.content !== 'string') throw new Error('OPERATOR_SOURCE');
      text = `Current public source ${route.repository}@${commit.sha}\n` +
        Buffer.from(file.content, 'base64').toString('utf8');
    }
    if (Buffer.byteLength(text) > 16000 || text.includes('\u0000')) {
      throw new Error('OPERATOR_EVIDENCE_LIMIT');
    }
    const row = { current: true, id: `${kind}:${target}`, text };
    approved.add(row);
    return row;
  };
  return { requests, observe, approvePublic: row => approved.has(row) };
}
