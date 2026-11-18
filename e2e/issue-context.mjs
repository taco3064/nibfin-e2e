import { operatorInputBytes } from './operator-input.mjs';

// Public diagnostics are a finite code-owned vocabulary, never exception text.
const evidenceReasons = new Set([
  'OPERATOR_EVIDENCE_LIMIT', 'OPERATOR_ISSUES_INCOMPLETE',
  'OPERATOR_INPUT_LIMIT', 'OPERATOR_ASSESSMENT_LIMIT',
  'OPERATOR_ISSUE_CONTENT_UNAVAILABLE',
]);
export function evidenceReason(error) {
  return evidenceReasons.has(error?.message) ? error.message : null;
}

// GitHub represents an Issue with no body as null; missing content is different.
export const hasIssueBody = issue =>
  issue?.body === null || typeof issue?.body === 'string';

export function issueContext(issue, repository, content = false) {
  if (!Number.isSafeInteger(issue?.id) || issue.id <= 0 ||
      !Number.isSafeInteger(issue.number) || issue.number <= 0 ||
      !['open', 'closed'].includes(issue.state) ||
      typeof issue.title !== 'string' || issue.pull_request ||
      content && !hasIssueBody(issue)) {
    throw new Error('OPERATOR_ISSUE_CONTENT_UNAVAILABLE');
  }
  return { repository, id: issue.id, number: issue.number,
    title: issue.title, state: issue.state,
    ...(content ? { body: issue.body } : {}) };
}

// Account for the entire surrounding assessment input, not just Issue bodies.
export function issueBatches(issues, repository, base, limit = 256000) {
  const batches = [];
  let batch = [];
  for (const issue of issues) {
    const projected = issueContext(issue, repository, true);
    if (operatorInputBytes({ ...base, issues: [...batch, projected] }) > limit) {
      if (!batch.length) throw new Error('OPERATOR_ASSESSMENT_LIMIT');
      batches.push(batch);
      batch = [];
    }
    batch.push(projected);
    if (operatorInputBytes({ ...base, issues: batch }) > limit) {
      throw new Error('OPERATOR_ASSESSMENT_LIMIT');
    }
  }
  if (batch.length || !batches.length) batches.push(batch);
  if (operatorInputBytes({ ...base, issues: [] }) > limit) {
    throw new Error('OPERATOR_ASSESSMENT_LIMIT');
  }
  return batches;
}

export function combineAssessments(decisions, key) {
  if (!decisions.length) return { duplicate: 'unresolved' };
  const valid = decisions.every(row => row?.publicSafe === true &&
    row.english === true && row.codeBacked === true && row.key === key &&
    ['none', 'existing', 'addressed', 'recurrence'].includes(row.duplicate) &&
    (row.duplicate !== 'recurrence' || row.newMaintainedChange === true));
  if (!valid) return { duplicate: 'unresolved' };
  const matches = decisions.filter(row => row.duplicate !== 'none');
  const first = matches[0] ?? decisions[0];
  if (matches.some(row => row.duplicate !== first.duplicate ||
      row.number !== first.number || row.existingId !== first.existingId ||
      row.existingTitle !== first.existingTitle ||
      row.existingBody !== first.existingBody)) return { duplicate: 'unresolved' };
  return first;
}
