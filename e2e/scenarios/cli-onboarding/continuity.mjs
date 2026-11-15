import assert from 'node:assert/strict';
import { wakeFixture } from '../wake-fixtures.mjs';
import { readWakeContinuity } from '../../wake-continuity.mjs';

export const continuityCases = ['unchanged', 'advanced', 'disabled', 'removed',
  'replaced', 'restored', 'forged', 'unrelated', 'missing'];

// Controlled GraphQL transport, evaluated by the prepared Core's real reader.
// These are synthetic observations, never a live-provider continuity receipt.
export async function exerciseContinuity(sources) {
  const { expected, evidence } = wakeFixture();
  const enrollment = evidence.enrollment;
  enrollment.origin = 'operator';
  enrollment.sources = Object.fromEntries(['core', 'action', 'cli'].map(key =>
    [key, { repository: sources[key].repository, commit: sources[key].commit }]));
  const passed = [];
  for (const kind of continuityCases) {
    const request = async (repository, token, query, variables) => {
      if (kind === 'missing') return undefined;
      const { anchor, path } = variables;
      const execution = repository === expected.runRepository;
      const current = kind === 'unchanged' ? anchor : 'e'.repeat(40);
      const file = { oid: 'd'.repeat(40), mode: 0o100644,
        object: { byteSize: 100 } };
      const commit = oid => ({ oid, file: structuredClone(file),
        history: { nodes: [{ oid: 'a'.repeat(40) }] } });
      const repo = { databaseId: execution ? 12 : 11,
        nameWithOwner: repository, isPrivate: false, isArchived: false,
        isDisabled: false, object: commit(anchor), defaultBranchRef: {
          name: 'main', target: commit(current), compare: {
            baseTarget: { oid: current }, headTarget: { oid: anchor },
            status: current === anchor ? 'IDENTICAL' : 'BEHIND' } } };
      const node = { databaseId: execution ? 502 : 500, state: 'ACTIVE',
        resourcePath: `/${repository}/actions/workflows/${path.split('/').at(-1)}` };
      const latest = repo.defaultBranchRef.target;
      if (kind === 'disabled') node.state = 'DISABLED_MANUALLY';
      if (kind === 'removed') latest.file = null;
      if (kind === 'replaced') latest.file.oid = 'f'.repeat(40);
      if (kind === 'restored') latest.history.nodes[0].oid = 'f'.repeat(40);
      if (kind === 'forged') node.databaseId++;
      if (kind === 'unrelated') repo.defaultBranchRef.compare.status = 'DIVERGED';
      return { repository: repo, node };
    };
    const result = await readWakeContinuity({ sources, expected, enrollment,
      workflows: { issue: 'W_issue', execution: 'W_execution' }, request });
    assert.equal(result.state, ['unchanged', 'advanced'].includes(kind)
      ? 'satisfied' : 'unverified', kind);
    passed.push(kind);
  }
  return { evidence: 'synthetic', passed };
}
