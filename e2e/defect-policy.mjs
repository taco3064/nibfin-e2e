export const defectEvidenceKinds = Object.freeze(['source', 'callers', 'issues']);

const identifier = value => typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(value);
export const positiveId = value => Number.isSafeInteger(value) && value > 0;
export function defectConfiguration(value) {
  if (!value || !Array.isArray(value.targets) || !value.targets.length ||
      value.targets.length > 10 || !positiveId(value.assignee?.id) ||
      !identifier(value.assignee.login) || value.label !== 'scope') {
    throw new Error('DEFECT_CONFIGURATION');
  }
  const targets = value.targets.map(row => {
    if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(row.repository ?? '') ||
        !positiveId(row.id)) throw new Error('DEFECT_CONFIGURATION');
    return { repository: row.repository, id: row.id };
  });
  if (new Set(targets.map(row => row.repository)).size !== targets.length) {
    throw new Error('DEFECT_CONFIGURATION');
  }
  return { targets, assignee: { id: value.assignee.id,
    login: value.assignee.login }, label: value.label };
}

export function validateFinding(finding, evidence, config) {
  const text = (value, limit) => typeof value === 'string' && value.trim() &&
    value.length <= limit && !/[\u0000-\u0008\u000b-\u001f]/.test(value);
  const target = config.targets.find(row => row.repository === finding?.repository);
  if (!target || finding.classification !== 'implementation_defect' ||
      !identifier(finding.behavior) || !identifier(finding.changeIdentity) ||
      !identifier(finding.ownerSource) ||
      finding.ownerSource.split('/').includes('..') ||
      !text(finding.necessaryChange, 2000) || !text(finding.title, 180) ||
      !text(finding.body, 12000) || finding.body.includes('<!-- nibfin-defect:') ||
      !text(finding.duplicate, 2000) ||
      !Array.isArray(finding.evidence) || finding.evidence.length > 24 ||
      !finding.evidence.length) throw new Error('FINDING_UNSUPPORTED');
  const used = finding.evidence.map(id => evidence.find(row => row.id === id));
  if (used.some(row => !row) || !defectEvidenceKinds.every(kind =>
    used.some(row => row.kind === kind))) throw new Error('FINDING_UNGROUNDED');
  return { repository: target.repository, behavior: finding.behavior,
    ownerSource: finding.ownerSource, changeIdentity: finding.changeIdentity,
    necessaryChange: finding.necessaryChange,
    title: finding.title, body: finding.body, duplicate: finding.duplicate,
    evidence: used };
}

// No hash/version prerequisite: a stable semantic tuple is the journal key.
export function defectKey(finding) {
  return JSON.stringify([finding.repository, finding.ownerSource,
    finding.behavior, finding.changeIdentity]);
}
export function defectMarker(key) {
  return `<!-- nibfin-defect:${Buffer.from(key).toString('base64url')} -->`;
}
export function issueMatches(issue, content, config, repository) {
  return positiveId(issue?.id) && positiveId(issue.number) &&
    typeof issue.node_id === 'string' && Boolean(issue.node_id) &&
    issue.url === `https://api.github.com/repos/${repository}/issues/${issue.number}` &&
    !issue.pull_request &&
    ['open', 'closed'].includes(issue.state) && issue.title === content.title &&
    issue.body === content.body &&
    issue.assignees?.some(row => row.id === config.assignee.id &&
      row.login === config.assignee.login) &&
    issue.labels?.some(row => row.name === config.label);
}

export function issueBrowserUrl(issue, repository) {
  const expected = `https://github.com/${repository}/issues/${issue.number}`;
  return positiveId(issue.number) && issue.html_url === expected ? expected : null;
}
