// The product-decision branch of the pending resolution stage (Proposal R4.45, R4.51): a
// fixture that leaves how halves round to a person stops with `pending`; the resolution
// record gives 2–4 numbered options with one recommended and changes nothing; a decision
// comment answers with an option number alone and `pending` is removed; the next Shape
// changes the Issue as decided and publishes. Reported `waiting` until the stage is
// delivered (R8.20).
//
// Until the amended R4.51 is delivered, the Owner alone answers. After it, the Owner
// answers first and the second write collaborator answers later with an option of a
// different rule, and the Issue must newly name the later option's rule, not the Owner's;
// when no two options resolve to different rules, the collaborator's answer alone decides.
import { GitHubError } from '../../src/host/github.ts';
import type { GitHub } from '../../src/host/github.ts';
import type { Outcome } from '../../src/types.ts';
import { briefRecord, pendingAddedAt, resolutionGate, resolutionRecord } from '../lib/resolution.ts';
import type { ResolutionOption, ResolutionRecord } from '../lib/resolution.ts';
import { AGENT_STAGES, Checks, markerOf, time } from './analysis.ts';
import type { Comment, Issue } from './analysis.ts';
import { DEADLINE, changeRequest, lifecycle, message } from './kit.ts';
import type { FixtureSpec, Kit } from './kit.ts';
import type { Snapshot } from './observe.ts';

const MIN = 60_000;

/** The fixture's open product choice, left explicitly to the Owner. It names no rounding rule. */
export const DECISION_EXTRA =
  'How exact halves round (for example 2.5 and -2.5) is an open product decision that the Owner has not made yet. Do not choose a rule yourself and do not implement until the Owner has decided; stop and ask the Owner, giving the possible rules and their consequences.';

/** The fixture body for the files under `src/<slug>.js`; it names no rounding rule. */
export function decisionBody(slug: string): string {
  return changeRequest(slug, 'roundHalf(x)', 'rounds a number to the nearest integer', DECISION_EXTRA);
}

/** The product-decision fixture (shared with the Dashboard resolution scenario): `scope`, the Owner as Assignee. */
export async function decisionFixture(k: Kit, scenario: string): Promise<FixtureSpec> {
  const owner = await k.owner();
  return {
    scenario,
    title: 'Add roundHalf',
    body: decisionBody(k.slug('round')),
    labels: ['scope'],
    assignees: [owner.login],
  };
}

/**
 * Waits until the fixture has `pending` and returns the Issue from the first snapshot that
 * shows it (its body is the baseline for "unchanged", R4.45). It ends early when Shape
 * published instead, the Issue closed, or a shape job completed and another stage followed.
 */
export async function awaitDecisionStop(k: Kit, n: number, show: (s: Snapshot) => Promise<string>): Promise<Issue> {
  const gone = k.stageGone(k.exec, n, 'shape', { allowPending: true });
  return k.obs.until(
    `#${n} to stop with pending`,
    (s) => {
      const i = k.issue(s, k.exec, n);
      return i?.labels.some((l) => l.name === 'pending') ? i : undefined;
    },
    DEADLINE.stage,
    show,
    {
      gonePast: async (s) =>
        k.labels(s, k.exec, n).includes('shaped')
          ? `#${n}: Shape was published without stopping: the agent chose the rounding itself`
          : gone(s),
    },
  );
}

// ---- pure helpers ----

/** Problems of a product-decision record's options (R4.45): 2–4, exactly one recommended, each with text, numbers unique. */
export function optionProblems(r: ResolutionRecord): string[] {
  const out: string[] = [];
  const os = r.options;
  if (os.length < 2 || os.length > 4) out.push(`the record has ${os.length} numbered options, not 2–4`);
  const rec = os.filter((o) => o.recommended).length;
  if (rec !== 1) out.push(`${rec} options are marked as recommended, not exactly one`);
  for (const o of os)
    if (withoutRecommendation(o.text).replace(/[\s\p{P}\p{S}]/gu, '').length < 2)
      out.push(`option ${o.n} has no text beyond its number`);
  const nums = os.map((o) => o.n);
  const dup = [...new Set(nums.filter((x, i) => nums.indexOf(x) !== i))];
  if (dup.length) out.push(`option numbers repeat: ${dup.join(', ')}`);
  return out;
}

export type RuleName = 'half-even' | 'half-away' | 'half-up' | 'half-down';

/** Terms that each name exactly one way of rounding halves. General rounding words are deliberately absent. */
export const ROUNDING_RULES: { id: RuleName; terms: RegExp[] }[] = [
  {
    id: 'half-even',
    terms: [/\bhalf[- ]to[- ]even\b/i, /\bround half even\b/i, /\beven\b/i, /\bbanker/i, /偶數/, /五成雙/, /銀行家/],
  },
  { id: 'half-away', terms: [/\baway from zero\b/i, /遠離零/, /遠離 ?0/] },
  { id: 'half-up', terms: [/\bhalf[- ]up\b/i, /\btowards? (\+|positive) ?infinity\b/i, /正無窮/] },
  { id: 'half-down', terms: [/\bhalf[- ]down\b/i, /\btowards? zero\b/i, /向零/] },
];

const RECOMMENDATION = /建議|推薦|recommend(?:ed|ation)?/gi;
const withoutRecommendation = (text: string) => text.replace(RECOMMENDATION, '');
const LEAD_END = /[:：—–(（;；,，→\r\n]/;

/** The rules named in `text`, each with the earliest position of its terms. */
function rulesIn(text: string): { id: RuleName; at: number }[] {
  const out: { id: RuleName; at: number }[] = [];
  for (const r of ROUNDING_RULES) {
    const at = Math.min(...r.terms.map((t) => t.exec(text)?.index ?? Infinity));
    if (at !== Infinity) out.push({ id: r.id, at });
  }
  return out;
}

/**
 * The one rounding rule an option names, or undefined: the rule named in its lead text
 * (before the first separator), else the rule whose term starts earliest; two rules in
 * the lead, or two starting at the same place, are ambiguous.
 */
export function optionRule(text: string): RuleName | undefined {
  const t = withoutRecommendation(text).replace(/^[\s\p{P}\p{S}]+/u, '');
  const lead = t.split(LEAD_END)[0] ?? '';
  const inLead = rulesIn(lead);
  if (inLead.length === 1) return inLead[0]?.id;
  if (inLead.length > 1) return undefined;
  const all = rulesIn(t).sort((a, b) => a.at - b.at);
  if (!all.length) return undefined;
  if (all.length > 1 && all[0]?.at === all[1]?.at) return undefined;
  return all[0]?.id;
}

const termsOf = (rule: RuleName) => ROUNDING_RULES.find((r) => r.id === rule)?.terms ?? [];

/** An option together with the one rounding rule it resolves to. */
export interface OptionPick {
  option: ResolutionOption;
  rule: RuleName;
}

/** The record's options that resolve to one rule with a term not in `oldBody`, in record order. */
export function qualifying(r: ResolutionRecord, oldBody: string): OptionPick[] {
  return r.options.flatMap((option) => {
    const rule = optionRule(option.text);
    return rule && termsOf(rule).some((t) => !t.test(oldBody)) ? [{ option, rule }] : [];
  });
}

/**
 * The option the harness decides on: the first non-recommended option that resolves to
 * one rule with a term not in `oldBody`, else the recommended one if it qualifies.
 */
export function chooseOption(r: ResolutionRecord, oldBody: string): OptionPick | undefined {
  const ok = qualifying(r, oldBody);
  return ok.find((x) => !x.option.recommended) ?? ok.find((x) => x.option.recommended);
}

/**
 * Two qualifying options with different rules: `overridden`, answered first, and `winner`,
 * answered later by another write collaborator. The winner prefers a non-recommended
 * option, so a Shape that follows the recommendation instead of the latest comment cannot
 * pass by chance; the overridden one prefers the recommended option. Undefined when fewer
 * than two distinct rules qualify.
 */
export function chooseTwoOptions(
  r: ResolutionRecord,
  oldBody: string,
): { overridden: OptionPick; winner: OptionPick } | undefined {
  const ok = qualifying(r, oldBody);
  const byRecommended = (first: boolean) => [
    ...ok.filter((x) => x.option.recommended === first),
    ...ok.filter((x) => x.option.recommended !== first),
  ];
  for (const winner of byRecommended(false)) {
    const overridden = byRecommended(true).find((x) => x.rule !== winner.rule);
    if (overridden) return { overridden, winner };
  }
  return undefined;
}

/** The text of a term of `rule` that `newBody` newly carries (absent from `oldBody`), or undefined. */
export function reflectedTerm(oldBody: string, newBody: string, rule: RuleName): string | undefined {
  if (newBody === oldBody) return undefined;
  for (const t of termsOf(rule)) {
    if (t.test(oldBody)) continue;
    const m = t.exec(newBody);
    if (m) return m[0];
  }
  return undefined;
}

/** Whether the new body differs and newly carries a term of the chosen rule; other rules' terms never count. */
export function reflects(oldBody: string, newBody: string, rule: RuleName): boolean {
  return reflectedTerm(oldBody, newBody, rule) !== undefined;
}

/** Every rule `newBody` newly names (a term absent from `oldBody`), in `ROUNDING_RULES` order. */
export function newlyNamed(oldBody: string, newBody: string): RuleName[] {
  return ROUNDING_RULES.filter((r) => reflectedTerm(oldBody, newBody, r.id) !== undefined).map((r) => r.id);
}

/**
 * The rule a decision in the person's own words states: one with a term not in `oldBody`.
 * It prefers, in `ROUNDING_RULES` order, a rule whose terms appear in no option's text
 * (`unnamed`), so Shape can only learn it from the words; then a rule no option resolves
 * to; then any rule an option resolves to. Undefined when no rule has a new term.
 */
export function chooseWordsRule(
  r: ResolutionRecord,
  oldBody: string,
): { rule: RuleName; unnamed: boolean } | undefined {
  const fresh = ROUNDING_RULES.filter((x) => x.terms.some((t) => !t.test(oldBody)));
  const unnamed = fresh.find((x) => !r.options.some((o) => x.terms.some((t) => t.test(o.text))));
  if (unnamed) return { rule: unnamed.id, unnamed: true };
  const resolved = new Set(r.options.map((o) => optionRule(o.text)));
  const other = fresh.find((x) => !resolved.has(x.id)) ?? fresh[0];
  return other && { rule: other.id, unnamed: false };
}

/** One sentence per rule, without digits, that names that rule's terms and no other rule's. */
export const WORDS_RULE_TEXT: Record<RuleName, string> = {
  'half-down': 'Round exact halves toward zero.',
  'half-away': 'Round exact halves away from zero.',
  'half-up': 'Round exact halves toward positive infinity.',
  'half-even': "Round exact halves to the nearest even integer (banker's rounding).",
};

/**
 * A decision in the person's own words: the rule's sentence, a request to add `label`
 * (a part Shape cannot apply, R4.51), and a line saying the harness wrote it. It carries
 * no option number; the only digits are inside the label.
 */
export function wordsDecision(rule: RuleName, label: string): string {
  return [
    WORDS_RULE_TEXT[rule],
    `Also add the label \`${label}\` to this Issue.`,
    'This decision was written by the automated nibfin-e2e harness.',
  ].join('\n\n');
}

/** Whether `text` is only a number, or has a standalone integer equal to one of `numbers`. */
export function bareNumberIn(text: string, numbers: number[]): boolean {
  if (/^\s*\d+\s*$/.test(text)) return true;
  return (text.match(/\b\d+\b/g) ?? []).some((t) => numbers.includes(Number(t)));
}

/**
 * Whether a part Shape cannot apply was handled openly (R4.51): the Issue carries `label`,
 * or a comment other than the decision, written or updated at or after `removedAt`, names
 * it. `read` lists the comments considered, for a failure message.
 */
export function unappliedNamed(input: {
  labels: string[];
  comments: Comment[];
  label: string;
  decisionId: number;
  removedAt: number;
}): { ok: boolean; where?: string; read: string[] } {
  const later = input.comments.filter(
    (c) => c.id !== input.decisionId && Math.max(time(c.created_at), time(c.updated_at)) >= input.removedAt,
  );
  const read = later.map((c) => `${c.html_url} by ${c.user?.login ?? 'unknown'}`);
  if (input.labels.includes(input.label)) return { ok: true, where: `the Issue carries ${input.label}`, read };
  const want = input.label.toLowerCase();
  const naming = later.find((c) => (c.body ?? '').toLowerCase().includes(want));
  return naming ? { ok: true, where: `${naming.html_url} names ${input.label}`, read } : { ok: false, read };
}

const normal = (b: string) =>
  b
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

/** Whether two Issue bodies are the same, ignoring line endings and trailing whitespace. */
export function bodyUnchanged(base: string, read: string): boolean {
  return normal(base) === normal(read);
}

// ---- shared steps ----

/**
 * Waits for the resolution record written after `pendingAt` and returns it with the
 * snapshot that showed it. It ends early when `pending` goes first or the Issue closes,
 * and throws naming the marker keys seen after `pendingAt`.
 */
export async function awaitResolutionRecord(
  k: Kit,
  n: number,
  pendingAt: number,
): Promise<{ r: ResolutionRecord; s: Snapshot }> {
  const { exec } = k;
  let keys: string[] = [];
  const markerKeys = (cs: Comment[]) =>
    cs
      .filter((x) => Math.max(time(x.created_at), time(x.updated_at)) >= pendingAt)
      .flatMap((x) => markerOf(x.body) ?? []);
  const closed = k.stageGone(exec, n, 'shape', { since: pendingAt - MIN, allowPending: true, jobs: false });
  try {
    return await k.obs.until(
      `a resolution record on #${n}`,
      async (s) => {
        const cs = await k.obs.comments(exec, n);
        keys = markerKeys(cs);
        const r = resolutionRecord(cs, pendingAt);
        return r ? { r, s } : undefined;
      },
      DEADLINE.stage,
      (s) => `#${n} labels: ${k.labels(s, exec, n).join(', ') || 'none'}`,
      {
        quiet: true,
        gonePast: async (s) =>
          k.issue(s, exec, n) && !k.labels(s, exec, n).includes('pending')
            ? `#${n} lost pending before a resolution record appeared`
            : closed(s),
      },
    );
  } catch (error) {
    throw new Error(
      `no resolution record on #${n} after pending was added at ${new Date(pendingAt).toISOString()} (${message(error)}); marker keys seen after it: ${keys.join(', ') || 'none'}`,
      { cause: error },
    );
  }
}

/**
 * Waits for a new shape run created at or after `removedAt` and then for `shaped`. It
 * ends with a named reason when Shape stops again with `pending`, the Issue closes, or
 * another agent stage runs before any new shape run.
 */
export async function awaitShapeAfterDecision(
  k: Kit,
  n: number,
  removedAt: number,
  show: (s: Snapshot) => Promise<string>,
): Promise<void> {
  const { exec } = k;
  const shapeGone = k.stageGone(exec, n, 'shape', { since: removedAt - MIN, publishes: 'shaped' });
  const gonePast = async (s: Snapshot) => (await shapeGone(s)) ?? unexpectedStage(k, s, n, removedAt);
  await k.obs.until(
    `a new shape run on #${n} after pending was removed`,
    (s) => k.stages(s, exec, n, ['shape']).find((x) => time(x.created_at) >= removedAt),
    DEADLINE.stage,
    show,
    { gonePast },
  );
  await k.obs.until(
    `#${n} to get shaped after the decision`,
    (s) => (k.labels(s, exec, n).includes('shaped') ? true : undefined),
    DEADLINE.stage,
    show,
    { gonePast },
  );
}

/** Who writes a decision comment: the Owner through the harness client, or another write collaborator. */
export interface DecisionAuthor {
  /** How the author appears in failure text. */
  name: string;
  github: GitHub;
  /** The login the read-back comment must carry; unchecked when absent. */
  login?: string;
}

/**
 * Posts `body` on Issue `n` as `author` and reads it back through the Owner's client; it
 * throws when GitHub refuses the comment (naming the author and HTTP status), or when the
 * read-back body or author differs.
 */
export async function postDecision(k: Kit, n: number, body: string, author: DecisionAuthor): Promise<Comment> {
  let posted: Comment;
  try {
    ({ data: posted } = await author.github.rest<Comment>('POST', `/repos/${k.exec}/issues/${n}/comments`, { body }));
  } catch (error) {
    const status = error instanceof GitHubError ? ` (HTTP ${error.status})` : '';
    throw new Error(`${author.name} could not post the decision comment on #${n}${status}: ${message(error)}`, {
      cause: error,
    });
  }
  const { data: back } = await k.gh.rest<Comment>('GET', `/repos/${k.exec}/issues/comments/${posted.id}`);
  if (back.body !== body)
    throw new Error(
      `the decision comment ${posted.id} on #${n} reads back "${briefRecord(back.body ?? '', 40)}", expected "${briefRecord(body, 40)}"`,
    );
  if (author.login !== undefined && back.user?.login !== author.login)
    throw new Error(
      `the decision comment ${posted.id} on #${n} reads back as written by ${back.user?.login ?? 'nobody'}, expected ${author.login}`,
    );
  return back;
}

/** Why the wait for the next Shape can no longer succeed: another agent stage ran before any new shape run. */
export function unexpectedStage(k: Kit, s: Snapshot, n: number, removedAt: number): string | undefined {
  const runs = k.stages(s, k.exec, n, AGENT_STAGES).filter((r) => time(r.created_at) >= removedAt);
  const firstShape = runs.filter((r) => r.stage === 'shape').sort((a, b) => time(a.created_at) - time(b.created_at))[0];
  const other = runs.find(
    (r) => r.stage !== 'shape' && (!firstShape || time(r.created_at) < time(firstShape.created_at)),
  );
  return other
    ? `after pending was removed, a ${other.stage} run ${other.id} started (created ${other.created_at}) before any new shape run`
    : undefined;
}

// ---- the scenario ----

export const resolutionDecision = lifecycle({
  id: 'resolution-decision',
  rules: ['R4.45', 'R4.51'],
  concurrent: true,
  // The later decision is written by the second write collaborator, so its account must be provisioned.
  requires: ['collaborator'],
  async run(k) {
    const gate = await resolutionGate(k.gh, 'stage');
    if (gate) return gate;
    let n: number | undefined;
    try {
      return await decide(k, (x) => (n = x));
    } finally {
      await k.pauseOpen(k.exec, [n]);
    }
  },
});

/** One decision comment the scenario writes, in order. */
interface Answer {
  author: DecisionAuthor;
  pick: OptionPick;
  comment?: Comment;
}

const describe = (a: Answer) =>
  `${a.comment?.user?.login ?? a.author.name}'s ${a.comment?.html_url ?? 'comment'} (option ${a.pick.option.n}, ${a.pick.rule}: "${briefRecord(a.pick.option.text, 80)}")`;

async function decide(k: Kit, filed: (n: number) => void): Promise<Outcome> {
  const c = new Checks();
  const { exec } = k;
  const issue = await k.file(exec, await decisionFixture(k, 'resolution-decision'));
  const n = issue.number;
  filed(n);
  const filedBody = issue.body ?? '';
  const show = k.show(exec, n);

  // Stop: pending on the fixture (R3.9, R4.5).
  let stopped: Issue;
  try {
    stopped = await awaitDecisionStop(k, n, show);
  } catch (error) {
    c.fail('R4.45', message(error));
    return c.outcome('');
  }
  const stopBody = stopped.body ?? '';
  const pendingAt = await pendingAddedAt(k.gh, exec, n);

  // The resolution record (R4.49), read without acting.
  let seen: { r: ResolutionRecord; s: Snapshot };
  try {
    seen = await awaitResolutionRecord(k, n, pendingAt);
  } catch (error) {
    c.fail('R4.45', message(error));
    return c.outcome('');
  }
  const { r } = seen;
  const brief = briefRecord(r.body);
  c.check(
    'R4.45',
    r.class === 'product-decision',
    `the resolution record ${r.url} is classed ${r.class ?? (r.classLabel ? `"${briefRecord(r.classLabel, 80)}"` : 'nothing')}, not 產品決策: ${brief}`,
  );
  c.none(
    'R4.45',
    optionProblems(r).map((p) => `${p} (${r.url}): ${brief}`),
  );
  c.check(
    'R4.45',
    k.labels(seen.s, exec, n).includes('pending'),
    `#${n} lost pending by the time its resolution record was seen: ${brief}`,
  );
  c.check(
    'R4.45',
    bodyUnchanged(stopBody, k.issue(seen.s, exec, n)?.body ?? ''),
    `#${n}'s body changed between pending and the resolution record: ${briefRecord(k.issue(seen.s, exec, n)?.body ?? '')}`,
  );
  const later = await k.obs.fresh();
  c.check(
    'R4.45',
    k.labels(later, exec, n).includes('pending'),
    `#${n} lost pending one interval after its resolution record was seen: ${brief}`,
  );
  const blockers = await k.obs.blockedBy(exec, n);
  c.check(
    'R4.45',
    blockers.length === 0,
    `#${n} got a native Blocked by ${blockers.map((b) => `#${b.number}`).join(', ')} after pending`,
  );

  // The decision (R4.51): option numbers alone, then pending removed.
  const pick = chooseOption(r, filedBody);
  if (!r.options.length || !pick) {
    c.notExercised(
      'R4.51',
      `${r.options.length ? 'no option resolves to exactly one rounding rule new to the Issue' : 'the record has no numbered options'}: ${brief}`,
    );
    return c.outcome('');
  }
  const owner: DecisionAuthor = { name: 'the Owner', github: k.gh };
  let answers: Answer[];
  const amended = await resolutionGate(k.gh, 'decision');
  if (amended) {
    // Until the amended R4.51 is delivered, only the Owner's single bare number is checked.
    c.note(`the latest-decision check by a second write collaborator is waiting: ${amended.reason}`);
    answers = [{ author: owner, pick }];
  } else {
    let peer: DecisionAuthor;
    try {
      const p = k.ctx.peer();
      peer = { name: `the collaborator ${p.login}`, github: p.github, login: p.login };
    } catch (error) {
      c.fail('R4.51', `the second write collaborator cannot decide: ${message(error)}`);
      return c.outcome('');
    }
    const two = chooseTwoOptions(r, filedBody);
    if (two)
      answers = [
        { author: owner, pick: two.overridden },
        { author: peer, pick: two.winner },
      ];
    else {
      c.note(
        `only ${peer.login ?? 'the collaborator'} decided: fewer than two options resolve to distinct rules new to the Issue`,
      );
      answers = [{ author: peer, pick }];
    }
  }
  const { data: before } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`);
  c.check(
    'R4.45',
    bodyUnchanged(stopBody, before.body ?? ''),
    `#${n}'s body changed after pending, before the decision: ${briefRecord(before.body ?? '')}`,
  );
  for (const a of answers) {
    try {
      a.comment = await postDecision(k, n, String(a.pick.option.n), a.author);
    } catch (error) {
      if (a.author === owner) throw error;
      c.fail('R4.51', message(error));
      return c.outcome('');
    }
  }
  await k.removeLabel(exec, n, 'pending');
  const removedAt = k.now();
  const winner = answers.at(-1) as Answer;
  const overridden = answers.length > 1 ? answers[0] : undefined;
  const chosen = answers.map(describe).join(', then ');

  // The next Shape applies the latest decision and publishes.
  try {
    await awaitShapeAfterDecision(k, n, removedAt, show);
  } catch (error) {
    c.fail('R4.51', `after deciding ${chosen}: ${message(error)}`);
    return c.outcome('');
  }
  const { data: after } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`);
  const body = after.body ?? '';
  const term = reflectedTerm(filedBody, body, winner.pick.rule);
  const named = () => newlyNamed(filedBody, body).join(', ') || 'none';
  c.check(
    'R4.51',
    !bodyUnchanged(filedBody, body),
    `#${n} was shaped after deciding ${chosen}, but its body is unchanged`,
  );
  c.check(
    'R4.51',
    term !== undefined,
    `#${n}'s new body does not newly name ${winner.pick.rule} after deciding ${chosen}; it newly names: ${named()}: ${briefRecord(body)}`,
  );
  if (overridden)
    c.check(
      'R4.51',
      reflectedTerm(filedBody, body, overridden.pick.rule) === undefined,
      `#${n}'s new body newly names the earlier, overridden ${overridden.pick.rule} after deciding ${chosen}; it newly names: ${named()}: ${briefRecord(body)}`,
    );
  return c.outcome(
    `#${n} stopped with a 產品決策 record of ${r.options.length} options; deciding ${chosen} made the next Shape write "${term ?? ''}" into the Issue and publish`,
  );
}
