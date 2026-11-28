import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from '../../scenarios/lifecycle/analysis.ts';
import { peerForeignRuns, workflowFile } from '../../scenarios/lifecycle/phase2-fixtures.ts';

const PEER = 'o/peer';
const SHA = 'a02a285c0ffee0123456789abcdef0123456789a';

// A peer run as observed: the run `name` carries the run title.
const run = (id: number, title: string, extra: Partial<Run> = {}): Run => ({
  id,
  repo: PEER,
  name: title,
  display_title: title,
  path: '.github/workflows/nibfin-issue.yml',
  event: 'issues',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-26T10:00:00Z',
  head_sha: 'm',
  ...extra,
});

test('workflowFile drops an @ref suffix and is undefined without path', () => {
  equal(workflowFile(run(1, 't', { path: '.github/workflows/nibfin-issue.yml@main' })), '.github/workflows/nibfin-issue.yml');
  equal(workflowFile(run(1, 't')), '.github/workflows/nibfin-issue.yml');
  equal(workflowFile(run(1, 't', { path: undefined })), undefined);
  equal(workflowFile(run(1, 't', { path: '' })), undefined);
});

test('R4.32: the entry runs of any title, CI and CD are allowed', () => {
  const runs = [
    run(1, `Nibfin · ${PEER}#42 · wake`),
    run(2, `Nibfin · ${PEER}@${SHA} · wake`, { event: 'push', path: '.github/workflows/nibfin-issue.yml@main' }),
    run(3, `Nibfin · ${PEER}@nibfin/init · wake`, { event: 'push' }),
    run(4, 'Q', { name: 'Nibfin · Issue events' }),
    run(5, 'Add sum', { name: 'CI', path: '.github/workflows/ci.yml', event: 'pull_request' }),
    run(6, 'Add sum', { name: 'CD', path: '.github/workflows/cd.yml', event: 'push' }),
  ];
  deepEqual(peerForeignRuns(runs, PEER), []);
});

test('R4.32: a run of another workflow file is named by its file, title and id', () => {
  const title = `Nibfin · ${PEER}#42 · wake`;
  const out = peerForeignRuns([run(1, title), run(7, title, { path: '.github/workflows/nibfin-wake.yml' })], PEER);
  equal(out.length, 1);
  match(out[0] as string, /\.github\/workflows\/nibfin-wake\.yml/);
  match(out[0] as string, new RegExp(`"${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  match(out[0] as string, /\(run 7\)/);
});

test('R4.32: a path-less run outside the fallback is named by its name', () => {
  const out = peerForeignRuns([run(9, 'Deploy prod', { name: 'Deploy', path: undefined }), run(8, `Nibfin · ${PEER}#42 · wake`, { path: undefined })], PEER);
  deepEqual(out, ['Deploy "Deploy prod" (run 9)']);
});

test('R4.32: runs of another repository are ignored', () => {
  deepEqual(peerForeignRuns([run(1, 'Deploy', { repo: 'o/exec', path: '.github/workflows/deploy.yml' })], PEER), []);
});
