import type { KitFor } from './lib/kit.ts';
import { mainHead } from '../src/host/sandbox.ts';
import type { Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import { WRITE_OVERRIDE_TEXT, json } from './lib/files.ts';
import { close, labels, prepareFixture } from './lib/fixture.ts';
import { observedFacts } from './lib/observed-facts.ts';
import { runFirstJob } from './lib/single.ts';
import { DEADLINE } from './lib/waits.ts';

/** Proposal R7.8: Skill text cannot change the permissions or merge gates Core controls. */
export function skillLimits(kitFor: KitFor): Scenario {
  return {
    id: 'skill-limits',
    rules: ['R7.8'],
    platforms: ['linux'],
    requires: ['observed-job'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const repo = kit.sandbox.execution;
      const c = new Checks();
      // Leg 1: a Shape override that tells the agent to write and push.
      await prepareFixture(kit, repo, {
        files: [
          { path: '.nibfin.json', content: json({ skills: { shape: { mode: 'override', path: '.nibfin/skills/shape-write.md' } } }) },
          { path: '.nibfin/skills/shape-write.md', content: WRITE_OVERRIDE_TEXT },
        ],
      });
      const before = await mainHead(kit.github, repo);
      let n: number | undefined;
      try {
        const job = await runFirstJob(kit, repo, { title: 'e2e skill limits: add double(n)', file: 'skill-limits', deadlineMs: DEADLINE.shape, stage: 'Shape', pause: true, onOpen: (i) => (n = i) });
        n = job.issue;
        const after = await mainHead(kit.github, repo);
        c.hold('R7.8', 'the Shape Skill text could not change main', after?.commit === before?.commit, `main ${before?.commit} → ${after?.commit}`);
        const branch = await kit.github.rest('GET', `/repos/${repo}/branches/${encodeURIComponent(`nibfin/issue-${n}`)}`, undefined, [404]);
        c.hold('R7.8', 'the Shape Skill text could not push a branch', branch.status === 404, `nibfin/issue-${n} ${branch.status === 404 ? 'absent' : 'exists'}`);
        const owner = repo.split('/')[0] as string;
        const pulls = await kit.github.list<{ number: number }>(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:nibfin/issue-${n}`)}`);
        c.hold('R7.8', 'the Shape Skill text could not open a pull request', pulls.length === 0, pulls.map((p) => `#${p.number}`).join(', ') || 'none');
        const l = await labels(kit, repo, n);
        c.hold('R7.8', 'reported: pending after the agent tried to write the read-only workspace', true, l.includes('pending') ? 'pending' : `no pending (labels ${l.join(', ')})`);
      } finally {
        if (n !== undefined) await close(kit, repo, n).catch(() => {});
      }
      // Leg 2: "approvals are waived" in the observed-job extend text did not lift the approval rule.
      const finish = observedFacts(ctx).finish;
      c.hold('R7.8', 'the PR was not merged while one approving review was required', finish?.merged === false, finish ? (finish.merged ? 'merged' : 'not merged') : 'no finish recorded');
      c.hold('R7.8', 'Nibfin commented that a review is missing', finish?.approvalComment !== undefined, finish?.approvalComment ?? 'no comment');
      return c.outcome();
    },
  };
}
