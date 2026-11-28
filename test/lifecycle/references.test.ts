import { equal } from 'node:assert/strict';
import { test } from 'node:test';
import { findListing, refersToIssue } from '../../scenarios/lifecycle/analysis.ts';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';

const repo = 'o/exec';
const comment = (body: string, id = 1): Comment => ({
  id,
  body,
  created_at: '',
  updated_at: '',
  user: null,
  html_url: '',
});

test('refersToIssue accepts a URL listing', () => {
  equal(refersToIssue('- a: https://github.com/o/exec/issues/12', repo, 12), true);
  equal(refersToIssue('see https://github.com/o/exec/issues/12#issuecomment-99', repo, 12), true);
  equal(refersToIssue('https://github.com/O/Exec/issues/12.', repo, 12), true);
});

test('refersToIssue accepts #N and owner/repo#N, case-insensitive on the repository', () => {
  equal(refersToIssue('- #12', repo, 12), true);
  equal(refersToIssue('(#12)', repo, 12), true);
  equal(refersToIssue('- o/exec#12', repo, 12), true);
  equal(refersToIssue('- O/EXEC#12', repo, 12), true);
});

test('refersToIssue rejects a longer or shorter number', () => {
  equal(refersToIssue('#123', repo, 12), false);
  equal(refersToIssue('o/exec#123', repo, 12), false);
  equal(refersToIssue('https://github.com/o/exec/issues/123', repo, 12), false);
  equal(refersToIssue('#12', repo, 123), false);
  equal(refersToIssue('https://github.com/o/exec/issues/12', repo, 123), false);
  equal(refersToIssue('a#12', repo, 12), false);
});

test('refersToIssue rejects the same number in another repository', () => {
  equal(refersToIssue('other/r#12', repo, 12), false);
  equal(refersToIssue('https://github.com/other/r/issues/12', repo, 12), false);
  equal(refersToIssue('xo/exec#12', repo, 12), false);
  equal(refersToIssue('o/exec-2#12', repo, 12), false);
  equal(refersToIssue('https://github.com/o/exec2/issues/12', repo, 12), false);
  equal(refersToIssue('', repo, 12), false);
  equal(refersToIssue(null, repo, 12), false);
});

test('refersToIssue on an Origin: line matches only the exact request', () => {
  equal(refersToIssue('Origin: https://github.com/o/exec/issues/39', repo, 39), true);
  equal(refersToIssue('Origin: #39', repo, 39), true);
  equal(refersToIssue('Origin: o/exec#39', repo, 39), true);
  equal(refersToIssue('Origin: https://github.com/o/exec/issues/394', repo, 39), false);
  equal(refersToIssue('Origin: #394', repo, 39), false);
});

test('findListing needs a marked comment that references every Issue', () => {
  const urls = comment(
    '<!-- nibfin:scope-request -->\nIssues:\n- a: https://github.com/o/exec/issues/12\n- b: https://github.com/o/exec/issues/13',
    2,
  );
  equal(findListing([comment('hello'), urls], repo, [12, 13]), urls);
  const refs = comment('<!-- nibfin:scope-request -->\n- #12\n- o/exec#13', 3);
  equal(findListing([refs], repo, [12, 13]), refs);
  equal(
    findListing([comment('<!-- nibfin:scope-request -->\n- https://github.com/o/exec/issues/12')], repo, [12, 13]),
    undefined,
  );
  equal(findListing([comment('- #12\n- #13')], repo, [12, 13]), undefined);
  equal(findListing([comment('<!-- nibfin:scope-request -->\n- #123\n- other/r#13')], repo, [12, 13]), undefined);
});
