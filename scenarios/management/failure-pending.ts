import type { GitHub } from '../../src/host/github.ts';
import type { Scenario } from '../../src/types.ts';
import { Check, message } from '../lib/check.ts';
import { addLabels, createIssue, deleteFile, labelsOf, putFile, registrations, removeLabel, whoami } from '../lib/github.ts';
import { waitFor } from '../lib/wait.ts';

interface Comment {
  id: number;
  created_at: string;
  updated_at: string;
}

const comments = (gh: GitHub, repo: string, n: number) => gh.list<Comment>(`/repos/${repo}/issues/${n}/comments`);

/** The latest time any comment was written or updated (Proposal R3.42: a redo may update its comment). */
const lastWrite = (cs: Comment[]) => Math.max(0, ...cs.flatMap((x) => [Date.parse(x.created_at), Date.parse(x.updated_at)]));

export const failurePending: Scenario = {
  id: 'failure-pending',
  rules: ['R4.4', 'R4.5', 'R4.6'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const gh = ctx.github;
    const repo = ctx.sandbox.execution;
    const me = await whoami(gh);
    let issue: number | undefined;
    try {
      // An invalid .nibfin.json makes Core refuse the Job before any agent runs (Proposal R7.2).
      await putFile(gh, repo, '.nibfin.json', '{"tools": 1}\n', 'nibfin-e2e: add an invalid .nibfin.json');
      issue = (await createIssue(gh, repo, { title: 'e2e failure: invalid .nibfin.json', labels: ['scope'], assignees: [me.login] })).number;
      const n = issue;
      const failed = async () => ({ labels: await labelsOf(gh, repo, n), comments: await comments(gh, repo, n) });

      const first = await waitFor(failed, (s) => s.labels.includes('pending') && s.comments.length > 0, {
        what: `#${n} to get pending and a comment after its Job failed`,
        deadlineMs: 15 * 60_000,
        intervalMs: 20_000,
      });
      const removedAt = Date.now();
      await removeLabel(gh, repo, n, 'pending');
      await c.part('R4.4', async () => {
        const second = await waitFor(failed, (s) => s.labels.includes('pending') && lastWrite(s.comments) > removedAt, {
          what: `#${n} to be dispatched again and get pending with a new or updated comment after pending was removed`,
          deadlineMs: 15 * 60_000,
          intervalMs: 20_000,
        });
        c.that(second.comments.length >= first.comments.length, 'R4.5', `#${n} lost comments between the two failures`);
      });
      await c.part('R4.6', async () => {
        await waitFor(() => registrations(gh, repo), (rs) => rs.length > 0 && rs.every((r) => !r.busy), {
          what: `every Runner on ${repo} to be idle after the failed Jobs`,
          deadlineMs: 10 * 60_000,
          intervalMs: 15_000,
        });
      });
    } catch (error) {
      c.fail('R4.5', message(error));
    } finally {
      // pause before the configuration becomes valid again: otherwise a wake in between could
      // start a real Job for this Issue (real delivery is out of scope). If pausing fails, the
      // invalid file stays and the next run's sandbox reset removes it.
      if (issue !== undefined) await addLabels(gh, repo, issue, ['pause']);
      await deleteFile(gh, repo, '.nibfin.json', 'nibfin-e2e: remove the invalid .nibfin.json');
    }
    return c.outcome(`#${issue}: each failed Job added pending with a comment, and removing pending dispatched it again`);
  },
};
