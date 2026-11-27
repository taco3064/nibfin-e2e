import type { GitHub } from '../../src/host/github.ts';
import type { Scenario } from '../../src/types.ts';
import { Check, message } from '../lib/check.ts';
import { addLabels, createIssue, deleteFile, labelsOf, putFile, registrations, removeLabel, whoami } from '../lib/github.ts';
import { untilAborted } from '../../src/abort.ts';
import type { Comment } from '../lifecycle/analysis.ts';
import { markerOf, time } from '../lifecycle/analysis.ts';
import { briefRecord, pendingAddedAt, resolutionGate, resolutionRecord, resolutionRecords } from '../lib/resolution.ts';
import type { ResolutionRecord } from '../lib/resolution.ts';
import { sleep, waitFor } from '../lib/wait.ts';

const comments = (gh: GitHub, repo: string, n: number) => gh.list<Comment>(`/repos/${repo}/issues/${n}/comments`);

/** The latest time any comment was written or updated (Proposal R3.42: a redo may update its comment). */
const lastWrite = (cs: Comment[]) => Math.max(0, ...cs.flatMap((x) => [Date.parse(x.created_at), Date.parse(x.updated_at)]));

/** The rules of the pending resolution stage this scenario checks once the stage is delivered. */
const RESOLUTION_RULES = ['R4.40', 'R4.41', 'R4.46', 'R4.49', 'R4.52'];

const POLL_MS = 20_000;

export const failurePending: Scenario = {
  id: 'failure-pending',
  rules: ['R4.4', 'R4.5', 'R4.6', ...RESOLUTION_RULES],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const gh = ctx.github;
    const repo = ctx.sandbox.execution;
    const me = await whoami(gh);
    // Until the product delivers the resolution stage, R4.40… only wait (Proposal R8.20).
    const gate = await resolutionGate(gh, 'stage');
    let issue: number | undefined;
    let found: ResolutionRecord | undefined;
    try {
      // An invalid .nibfin.json makes Core refuse the Job before any agent runs (Proposal R7.2).
      await putFile(gh, repo, '.nibfin.json', '{"tools": 1}\n', 'nibfin-e2e: add an invalid .nibfin.json');
      issue = (await createIssue(gh, repo, { title: 'e2e failure: invalid .nibfin.json', labels: ['scope'], assignees: [me.login] })).number;
      const n = issue;
      const failed = async () => ({ labels: await labelsOf(gh, repo, n), comments: await comments(gh, repo, n) });

      const first = await waitFor(failed, (s) => s.labels.includes('pending') && s.comments.length > 0, {
        what: `#${n} to get pending and a comment after its Job failed`,
        deadlineMs: 15 * 60_000,
        signal: ctx.signal,
        intervalMs: POLL_MS,
      });
      if (!gate) found = await resolution(n);
      const removedAt = Date.now();
      await removeLabel(gh, repo, n, 'pending');
      // With the stage delivered, removing pending without a decision comment is one rerun (R4.52).
      await c.part(gate ? 'R4.4' : 'R4.4, R4.52', async () => {
        const second = await waitFor(failed, (s) => s.labels.includes('pending') && lastWrite(s.comments) > removedAt, {
          what: `#${n} to be dispatched again and get pending with a new or updated comment after pending was removed`,
          deadlineMs: 15 * 60_000,
          signal: ctx.signal,
          intervalMs: POLL_MS,
        });
        c.that(second.comments.length >= first.comments.length, 'R4.5', `#${n} lost comments between the two failures`);
      });
      await c.part('R4.6', async () => {
        await waitFor(() => registrations(gh, repo), (rs) => rs.length > 0 && rs.every((r) => !r.busy), {
          what: `every Runner on ${repo} to be idle after the failed Jobs`,
          deadlineMs: 10 * 60_000,
          signal: ctx.signal,
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
    const summary = `#${issue}: each failed Job added pending with a comment, and removing pending dispatched it again`;
    if (gate) {
      const out = c.outcome(summary);
      return out.status === 'passed' ? { status: 'waiting', reason: `R4.4–R4.6 passed (${summary}); ${RESOLUTION_RULES.join(', ')} wait: ${gate.reason}` } : out;
    }
    return c.outcome(`${summary}; the resolution record (${found?.class ?? 'no class'}) gave next steps and kept pending`);

    /** Waits, without acting, for the resolution record after the first pending and checks it (R4.40, R4.41, R4.46, R4.49). */
    async function resolution(n: number): Promise<ResolutionRecord | undefined> {
      let pendingAt: number;
      try {
        pendingAt = await pendingAddedAt(gh, repo, n);
      } catch (error) {
        c.fail('R4.40', message(error));
        return undefined;
      }
      const since = new Date(pendingAt).toISOString();
      const read = async () => {
        const [labels, cs] = await Promise.all([labelsOf(gh, repo, n), comments(gh, repo, n)]);
        return { labels, comments: cs, record: resolutionRecord(cs, pendingAt) };
      };
      let keys: string[] = [];
      let seen: Awaited<ReturnType<typeof read>>;
      try {
        seen = await waitFor(
          async () => {
            const s = await read();
            keys = s.comments.filter((x) => Math.max(time(x.created_at), time(x.updated_at)) >= pendingAt).flatMap((x) => markerOf(x.body) ?? []);
            return s;
          },
          (s) => s.record !== undefined,
          { what: `a resolution record on #${n}`, deadlineMs: 15 * 60_000, signal: ctx.signal, intervalMs: POLL_MS },
        );
      } catch (error) {
        ctx.signal.throwIfAborted();
        c.fail('R4.40', `no resolution record on #${n} within 15 min after pending was added at ${since}; marker keys seen after it: ${keys.join(', ') || 'none'} (${message(error)})`);
        return undefined;
      }
      const r = seen.record as ResolutionRecord;
      const brief = briefRecord(r.body);
      const count = resolutionRecords(seen.comments, pendingAt).length;
      c.that(count === 1, 'R4.49', `#${n} has ${count} resolution records after pending was added at ${since}, not one`);
      c.that(r.classLabel !== undefined || r.class !== undefined, 'R4.49', `the resolution record ${r.url} names no class: ${brief}`);
      c.that(r.cause !== undefined, 'R4.49', `the resolution record ${r.url} gives no one-sentence cause: ${brief}`);
      c.that(r.class !== undefined, 'R4.41', `the resolution record ${r.url} names no class of the six${r.classLabel ? ` (it says "${briefRecord(r.classLabel, 80)}")` : ''}: ${brief}`);
      c.that(
        r.class === 'operations-or-manual',
        'R4.46',
        `an invalid .nibfin.json needs a repository fix by a person (維運或人為操作), but the record ${r.url} gives ${r.class ?? r.classLabel ?? 'no class'}: ${brief}`,
      );
      c.that(r.nextSteps, 'R4.46', `the resolution record ${r.url} gives no next steps: ${brief}`);
      c.that(seen.labels.includes('pending'), 'R4.46', `#${n} lost pending by the time its resolution record was written: ${brief}`);
      await untilAborted(sleep(POLL_MS), ctx.signal);
      const later = await labelsOf(gh, repo, n);
      c.that(later.includes('pending'), 'R4.46', `#${n} lost pending within ${POLL_MS / 1000} s after its resolution record was written: ${brief}`);
      return r;
    }
  },
};
