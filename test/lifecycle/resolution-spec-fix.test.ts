// resolution-spec-fix's pure checks (Issue #553, Proposal R4.44, R4.48): the order edit,
// then record, then pending removed; and no code, protected-path or setting change in the window.
import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import type { Activity } from '../../scenarios/lifecycle/analysis.ts';
import {
  codeChangesIn,
  isProtected,
  settingsOf,
  skillPathsOf,
  specFixOrder,
} from '../../scenarios/lifecycle/resolution-spec-fix.ts';
import type { CodeChangeInput } from '../../scenarios/lifecycle/resolution-spec-fix.ts';

const T = Date.parse('2026-11-27T10:00:00Z');
const MIN = 60_000;

test('specFixOrder passes for edit, then record, then pending removed', () => {
  deepEqual(
    specFixOrder({
      pendingAt: T,
      edits: [T - MIN, T + MIN],
      blockedByAdded: [],
      recordAt: T + 2 * MIN,
      unpendedAt: T + 3 * MIN,
    }),
    [],
  );
});

test('specFixOrder counts a Blocked by added as the correction', () => {
  deepEqual(
    specFixOrder({
      pendingAt: T,
      edits: [],
      blockedByAdded: [T + MIN],
      recordAt: T + 2 * MIN,
      unpendedAt: T + 3 * MIN,
    }),
    [],
  );
});

test('specFixOrder fails without a correction after pending, naming the time', () => {
  const p = specFixOrder({
    pendingAt: T,
    edits: [T - MIN],
    blockedByAdded: [],
    recordAt: T + 2 * MIN,
    unpendedAt: T + 3 * MIN,
  });
  equal(p.length, 1);
  match(p[0] ?? '', /no body edit or Blocked by .*2026-11-27T10:00:00\.000Z/);
});

test('specFixOrder fails when the edit came after the record', () => {
  const p = specFixOrder({
    pendingAt: T,
    edits: [T + 2 * MIN],
    blockedByAdded: [],
    recordAt: T + MIN,
    unpendedAt: T + 3 * MIN,
  });
  equal(p.length, 1);
  match(
    p[0] ?? '',
    /correction at 2026-11-27T10:02:00\.000Z came after the resolution record at 2026-11-27T10:01:00\.000Z/,
  );
});

test('specFixOrder fails when the record came after the removal', () => {
  const p = specFixOrder({
    pendingAt: T,
    edits: [T + MIN],
    blockedByAdded: [],
    recordAt: T + 3 * MIN,
    unpendedAt: T + 2 * MIN,
  });
  equal(p.length, 1);
  match(p[0] ?? '', /record at 2026-11-27T10:03:00\.000Z came after pending was removed at 2026-11-27T10:02:00\.000Z/);
});

test('specFixOrder fails when pending was never removed', () => {
  const p = specFixOrder({ pendingAt: T, edits: [T + MIN], blockedByAdded: [], recordAt: T + 2 * MIN });
  deepEqual(p, ['pending, added at 2026-11-27T10:00:00.000Z, was not removed']);
});

const act = (id: number, ref: string, at: number, type = 'push'): Activity => ({
  id,
  ref,
  timestamp: new Date(at).toISOString(),
  activity_type: type,
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
});
const SETTINGS = settingsOf(
  {
    allow_rebase_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: true,
    delete_branch_on_merge: false,
    default_branch: 'main',
    visibility: 'public',
  },
  [{ name: 'e2e-ci', enforcement: 'active' }],
);
const input = (o: Partial<CodeChangeInput>): CodeChangeInput => ({
  activity: [],
  window: { start: T, end: T + 10 * MIN },
  n: 7,
  defaultBranch: 'main',
  files: new Map(),
  skillPaths: ['docs/agent/deliver.md'],
  settingsBefore: SETTINGS,
  settingsAfter: SETTINGS,
  ...o,
});

test('codeChangesIn fails on a push to the Issue branch inside the window', () => {
  const p = codeChangesIn(input({ activity: [act(1, 'refs/heads/nibfin/issue-7', T + MIN)] }));
  equal(p.length, 1);
  match(p[0] ?? '', /push to refs\/heads\/nibfin\/issue-7 at 2026-11-27T10:01:00\.000Z .*inside the resolution window/);
});

test('codeChangesIn passes the same push before the window', () => {
  deepEqual(codeChangesIn(input({ activity: [act(1, 'refs/heads/nibfin/issue-7', T - MIN)] })), []);
});

test('codeChangesIn passes a push to another Issue branch inside the window', () => {
  deepEqual(
    codeChangesIn(
      input({ activity: [act(1, 'refs/heads/nibfin/issue-70', T + MIN), act(2, 'nibfin/issue-8', T + MIN)] }),
    ),
    [],
  );
});

test('codeChangesIn fails on a new non-Issue branch inside the window', () => {
  const p = codeChangesIn(input({ activity: [act(1, 'refs/heads/fix-spec', T + MIN, 'branch_creation')] }));
  equal(p.length, 1);
  match(p[0] ?? '', /branch_creation to refs\/heads\/fix-spec/);
});

test('codeChangesIn ignores branch deletions', () => {
  deepEqual(codeChangesIn(input({ activity: [act(1, 'refs/heads/fix-spec', T + MIN, 'branch_deletion')] })), []);
});

test('codeChangesIn names the protected paths a default-branch write changed', () => {
  const p = codeChangesIn(
    input({ activity: [act(5, 'refs/heads/main', T + MIN)], files: new Map([[5, ['src/x.js', '.nibfin.json']]]) }),
  );
  equal(p.length, 1);
  match(p[0] ?? '', /refs\/heads\/main .*changing protected paths \.nibfin\.json$/);
});

test('codeChangesIn fails on a changed merge setting or ruleset enforcement', () => {
  const after = settingsOf(
    {
      allow_rebase_merge: true,
      allow_squash_merge: false,
      allow_merge_commit: true,
      delete_branch_on_merge: false,
      default_branch: 'main',
      visibility: 'public',
    },
    [{ name: 'e2e-ci', enforcement: 'disabled' }],
  );
  const p = codeChangesIn(input({ settingsAfter: after }));
  equal(p.length, 2);
  match(p[0] ?? '', /allow_squash_merge changed from true to false/);
  match(p[1] ?? '', /rulesets changed from e2e-ci:active to e2e-ci:disabled/);
});

test('isProtected covers the R3.46 paths and the role Skill paths, not ordinary files', () => {
  const skills = skillPathsOf(
    JSON.stringify({ skills: { deliver: { mode: 'extend', path: 'docs/agent/deliver.md' } } }),
  );
  deepEqual(skills, ['docs/agent/deliver.md']);
  for (const p of [
    '.github/workflows/ci.yml',
    '.nibfin.json',
    '.nibfin/x.md',
    '.rulesync/rules/a.md',
    'CODEOWNERS',
    '.github/CODEOWNERS',
    'docs/CODEOWNERS',
    'docs/agent/deliver.md',
  ])
    equal(isProtected(p, skills), true, p);
  for (const p of ['src/x.js', 'docs/readme.md', '.github/dependabot.yml']) equal(isProtected(p, skills), false, p);
  deepEqual(skillPathsOf('not json'), []);
});
