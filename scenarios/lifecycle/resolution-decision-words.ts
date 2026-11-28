// A decision in the person's own words (Proposal R4.51): the product-decision fixture of
// `resolution-decision` stops with `pending` and gets its numbered options; the Owner then
// answers with no option number, stating one rounding rule in plain words (where possible
// one no option names) and asking for one thing Shape cannot apply, a label with a unique
// name. After `pending` is removed, the next Shape must write the stated rule into the
// Issue and publish, and the label must be either on the Issue or named in a comment
// written after the removal, never skipped silently. Reported `waiting` until the amended
// R4.51 is delivered (R8.20).
import type { Outcome } from '../../src/types.ts';
import { briefRecord, pendingAddedAt, pendingRemovedAt, resolutionGate } from '../lib/resolution.ts';
import type { ResolutionRecord } from '../lib/resolution.ts';
import { Checks } from './analysis.ts';
import type { Comment, Issue } from './analysis.ts';
import { DEADLINE, lifecycle, message } from './kit.ts';
import type { Kit } from './kit.ts';
import {
  awaitDecisionStop,
  awaitResolutionRecord,
  awaitShapeAfterDecision,
  bareNumberIn,
  bodyUnchanged,
  chooseWordsRule,
  decisionFixture,
  newlyNamed,
  postDecision,
  reflectedTerm,
  unappliedNamed,
  wordsDecision,
} from './resolution-decision.ts';

const RULE = 'R4.51';

export const resolutionDecisionWords = lifecycle({
  id: 'resolution-decision-words',
  rules: [RULE],
  concurrent: true,
  async run(k) {
    const gate = await resolutionGate(k.gh, 'decision');
    if (gate) return gate;
    let n: number | undefined;
    try {
      return await decideInWords(k, (x) => (n = x));
    } finally {
      await k.pauseOpen(k.exec, [n]);
    }
  },
});

async function decideInWords(k: Kit, filed: (n: number) => void): Promise<Outcome> {
  const c = new Checks();
  const { exec } = k;
  const issue = await k.file(exec, await decisionFixture(k, 'resolution-decision-words'));
  const n = issue.number;
  filed(n);
  const filedBody = issue.body ?? '';
  const show = k.show(exec, n);

  // The stop and its resolution record.
  let r: ResolutionRecord;
  try {
    await awaitDecisionStop(k, n, show);
    ({ r } = await awaitResolutionRecord(k, n, await pendingAddedAt(k.gh, exec, n)));
  } catch (error) {
    c.fail(RULE, message(error));
    return c.outcome('');
  }
  const brief = briefRecord(r.body);
  if (r.class !== 'product-decision') {
    c.notExercised(RULE, `the resolution record ${r.url} is not classed 產品決策: ${brief}`);
    return c.outcome('');
  }
  if (!r.options.length) {
    c.notExercised(RULE, `the resolution record ${r.url} has no numbered options: ${brief}`);
    return c.outcome('');
  }
  const words = chooseWordsRule(r, filedBody);
  if (!words) {
    c.notExercised(RULE, `every rounding rule is already named in the filed body of #${n}`);
    return c.outcome('');
  }

  // The decision in plain words, with a part Shape cannot apply.
  const label = k.slug('unapplied');
  const text = wordsDecision(words.rule, label);
  const numbers = r.options.map((o) => o.n);
  if (bareNumberIn(text, numbers))
    throw new Error(`the harness's own-words decision carries an option number (${numbers.join(', ')}): ${text}`);
  const decision = await postDecision(k, n, text, { name: 'the Owner', github: k.gh });
  await k.removeLabel(exec, n, 'pending');
  const removedLocal = k.now();
  const stated = `the own-words decision ${decision.html_url} (${words.rule}${words.unnamed ? ', named by no option' : ''}, asking for the label ${label})`;

  // The next Shape writes the stated rule into the Issue and publishes.
  try {
    await awaitShapeAfterDecision(k, n, removedLocal, show);
  } catch (error) {
    c.fail(RULE, `after ${stated}: ${message(error)}`);
    return c.outcome('');
  }
  const { data: after } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`);
  const body = after.body ?? '';
  const term = reflectedTerm(filedBody, body, words.rule);
  c.check(RULE, !bodyUnchanged(filedBody, body), `#${n} was shaped after ${stated}, but its body is unchanged`);
  c.check(
    RULE,
    term !== undefined,
    `#${n}'s new body does not newly name ${words.rule} after ${stated}; it newly names: ${newlyNamed(filedBody, body).join(', ') || 'none'}: ${briefRecord(body)}`,
  );

  // The label: applied, or named in a comment written after the removal.
  const removedAt = await pendingRemovedAt(k.gh, exec, n);
  let judged: ReturnType<typeof unappliedNamed> = { ok: false, read: [] };
  const judge = (labels: string[], comments: Comment[]) =>
    (judged = unappliedNamed({ labels, comments, label, decisionId: decision.id, removedAt }));
  try {
    await k.obs.until(
      `#${n} to carry or name the label ${label}`,
      async (s) => (judge(k.labels(s, exec, n), await k.obs.comments(exec, n)).ok ? true : undefined),
      DEADLINE.quiet,
      show,
      { quiet: true },
    );
  } catch (error) {
    c.fail(
      RULE,
      `after ${stated}, #${n} neither carries ${label} nor names it in a comment written since pending was removed at ${new Date(removedAt).toISOString()} (${message(error)}); comments read: ${judged.read.join(', ') || 'none'}`,
    );
  }
  return c.outcome(
    `#${n} stopped with a 產品決策 record of ${r.options.length} options; ${stated} made the next Shape write "${term ?? ''}" into the Issue and publish, and ${judged.where ?? ''}`,
  );
}
