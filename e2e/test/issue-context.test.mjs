import test from 'node:test';
import assert from 'node:assert/strict';
import { issueBatches, combineAssessments } from '../issue-context.mjs';
import { operatorInputBytes } from '../operator-input.mjs';

const issue = number => ({ id: number, number, state: 'closed', title: 'History',
  body: 'Semantic evidence 🐟'.repeat(100) });
const approved = { publicSafe: true, english: true, codeBacked: true, key: 'key',
  duplicate: 'none' };

test('batch budgets include UTF-8 content and the surrounding source/finding', () => {
  const base = { finding: 'candidate', evidence: 'source'.repeat(100) };
  const issues = [issue(1), issue(2), issue(3)];
  const batches = issueBatches(issues, 'owner/repo', base, 4000);
  assert(batches.length > 1);
  for (const batch of batches) {
    assert(operatorInputBytes({ ...base, issues: batch }) <= 4000);
  }
  assert.deepEqual(batches.flat().map(row => row.body), issues.map(row => row.body));
  assert.throws(() => issueBatches([issue(1)], 'owner/repo', base, 1000),
    /OPERATOR_ASSESSMENT_LIMIT/);
  assert.throws(() => issueBatches([], 'owner/repo', base, 10),
    /OPERATOR_ASSESSMENT_LIMIT/);
  assert.throws(() => issueBatches([{ ...issue(1), body: undefined }],
    'owner/repo', base), /OPERATOR_ISSUE_CONTENT_UNAVAILABLE/);
});

test('absence requires every batch; failures and contradictory identities fail safe',
  () => {
    assert.equal(combineAssessments([approved, approved], 'key').duplicate, 'none');
    const existing = { ...approved, duplicate: 'existing', number: 1,
      existingId: 1, existingTitle: 'Work', existingBody: 'Full body' };
    assert.equal(combineAssessments([approved, existing], 'key'), existing);
    for (const other of [{ ...approved, publicSafe: false },
      { ...approved, duplicate: 'unresolved' }, { ...approved, key: 'wrong' },
      { ...existing, number: 2 }, { ...existing, duplicate: 'addressed' },
      { ...approved, duplicate: 'recurrence', newMaintainedChange: false }]) {
      assert.equal(combineAssessments([existing, other], 'key').duplicate,
        'unresolved');
    }
    assert.equal(combineAssessments([approved,
      { ...approved, duplicate: 'addressed', number: 1 }], 'key').duplicate,
    'addressed');
    assert.equal(combineAssessments([approved, { ...approved, duplicate: 'recurrence',
      number: 1, newMaintainedChange: true }], 'key').duplicate, 'recurrence');
  });

test('null and empty bodies remain complete content; malformed bodies fail safe', () => {
  const issues = [null, '', 'Full body'].map((body, index) =>
    ({ ...issue(index + 1), body }));
  const batches = issueBatches(issues, 'owner/repo', {});
  assert.deepEqual(batches.flat().map(row => row.body), [null, '', 'Full body']);
  assert.deepEqual(issues.map(row => row.body), [null, '', 'Full body']);
  for (const body of [undefined, 0, false, {}]) {
    assert.throws(() => issueBatches([{ ...issue(1), body }], 'owner/repo', {}),
      /OPERATOR_ISSUE_CONTENT_UNAVAILABLE/);
  }
});
