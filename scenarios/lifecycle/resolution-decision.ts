// The product-decision branch of the pending resolution stage (Proposal R4.45, R4.51): a
// fixture that leaves how halves round to a person stops with `pending`; the resolution
// record gives 2–4 numbered options with one recommended and changes nothing; the Owner
// answers with an option number alone and removes `pending`; the next Shape changes the
// Issue as decided and publishes. Reported `waiting` until the stage is delivered (R8.20).
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
  return { scenario, title: 'Add roundHalf', body: decisionBody(k.slug('round')), labels: ['scope'], assignees: [owner.login] };
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
      gonePast: async (s) => (k.labels(s, k.exec, n).includes('shaped') ? `#${n}: Shape was published without stopping: the agent chose the rounding itself` : gone(s)),
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
  for (const o of os) if (withoutRecommendation(o.text).replace(/[\s\p{P}\p{S}]/gu, '').length < 2) out.push(`option ${o.n} has no text beyond its number`);
  const nums = os.map((o) => o.n);
  const dup = [...new Set(nums.filter((x, i) => nums.indexOf(x) !== i))];
  if (dup.length) out.push(`option numbers repeat: ${dup.join(', ')}`);
  return out;
}

export type RuleName = 'half-even' | 'half-away' | 'half-up' | 'half-down';

/** Terms that each name exactly one way of rounding halves. General rounding words are deliberately absent. */
export const ROUNDING_RULES: { id: RuleName; terms: RegExp[] }[] = [
  { id: 'half-even', terms: [/\bhalf[- ]to[- ]even\b/i, /\bround half even\b/i, /\beven\b/i, /\bbanker/i, /偶數/, /五成雙/, /銀行家/] },
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

/**
 * The option the harness decides on: the first non-recommended option that resolves to
 * one rule with a term not in `oldBody`, else the recommended one if it qualifies.
 */
export function chooseOption(r: ResolutionRecord, oldBody: string): { option: ResolutionOption; rule: RuleName } | undefined {
  const ok = r.options.flatMap((option) => {
    const rule = optionRule(option.text);
    return rule && termsOf(rule).some((t) => !t.test(oldBody)) ? [{ option, rule }] : [];
  });
  return ok.find((x) => !x.option.recommended) ?? ok.find((x) => x.option.recommended);
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

// ---- the scenario ----

export const resolutionDecision = lifecycle({
  id: 'resolution-decision',
  rules: ['R4.45', 'R4.51'],
  concurrent: true,
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
  const since = new Date(pendingAt).toISOString();

  // The resolution record (R4.49), read without acting.
  let keys: string[] = [];
  const markerKeys = (cs: Comment[]) => cs.filter((x) => Math.max(time(x.created_at), time(x.updated_at)) >= pendingAt).flatMap((x) => markerOf(x.body) ?? []);
  const closed = k.stageGone(exec, n, 'shape', { since: pendingAt - MIN, allowPending: true, jobs: false });
  let seen: { r: ResolutionRecord; s: Snapshot };
  try {
    seen = await k.obs.until(
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
        gonePast: async (s) => (k.issue(s, exec, n) && !k.labels(s, exec, n).includes('pending') ? `#${n} lost pending before a resolution record appeared` : closed(s)),
      },
    );
  } catch (error) {
    c.fail('R4.45', `no resolution record on #${n} after pending was added at ${since} (${message(error)}); marker keys seen after it: ${keys.join(', ') || 'none'}`);
    return c.outcome('');
  }
  const { r } = seen;
  const brief = briefRecord(r.body);
  c.check('R4.45', r.class === 'product-decision', `the resolution record ${r.url} is classed ${r.class ?? (r.classLabel ? `"${briefRecord(r.classLabel, 80)}"` : 'nothing')}, not 產品決策: ${brief}`);
  c.none('R4.45', optionProblems(r).map((p) => `${p} (${r.url}): ${brief}`));
  c.check('R4.45', k.labels(seen.s, exec, n).includes('pending'), `#${n} lost pending by the time its resolution record was seen: ${brief}`);
  c.check('R4.45', bodyUnchanged(stopBody, k.issue(seen.s, exec, n)?.body ?? ''), `#${n}'s body changed between pending and the resolution record: ${briefRecord(k.issue(seen.s, exec, n)?.body ?? '')}`);
  const later = await k.obs.fresh();
  c.check('R4.45', k.labels(later, exec, n).includes('pending'), `#${n} lost pending one interval after its resolution record was seen: ${brief}`);
  const blockers = await k.obs.blockedBy(exec, n);
  c.check('R4.45', blockers.length === 0, `#${n} got a native Blocked by ${blockers.map((b) => `#${b.number}`).join(', ')} after pending`);

  // The decision (R4.51): one option number alone, then pending removed.
  const pick = chooseOption(r, filedBody);
  if (!r.options.length || !pick) {
    c.notExercised('R4.51', `${r.options.length ? 'no option resolves to exactly one rounding rule new to the Issue' : 'the record has no numbered options'}: ${brief}`);
    return c.outcome('');
  }
  const { data: before } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`);
  c.check('R4.45', bodyUnchanged(stopBody, before.body ?? ''), `#${n}'s body changed after pending, before the decision: ${briefRecord(before.body ?? '')}`);
  const answer = String(pick.option.n);
  const { data: posted } = await k.gh.rest<Comment>('POST', `/repos/${exec}/issues/${n}/comments`, { body: answer });
  const { data: back } = await k.gh.rest<Comment>('GET', `/repos/${exec}/issues/comments/${posted.id}`);
  if (back.body !== answer) throw new Error(`the decision comment ${posted.id} on #${n} reads back "${briefRecord(back.body ?? '', 40)}", expected "${answer}"`);
  await k.removeLabel(exec, n, 'pending');
  const removedAt = k.now();
  const chosen = `option ${answer} (${pick.rule}): "${briefRecord(pick.option.text, 120)}"`;

  // The next Shape applies the decision and publishes.
  const shapeGone = k.stageGone(exec, n, 'shape', { since: removedAt - MIN, publishes: 'shaped' });
  const gonePast = async (s: Snapshot) => (await shapeGone(s)) ?? unexpectedStage(k, s, n, removedAt);
  try {
    await k.obs.until(`a new shape run on #${n} after pending was removed`, (s) => k.stages(s, exec, n, ['shape']).find((x) => time(x.created_at) >= removedAt), DEADLINE.stage, show, { gonePast });
    await k.obs.until(`#${n} to get shaped after the decision`, (s) => (k.labels(s, exec, n).includes('shaped') ? true : undefined), DEADLINE.stage, show, { gonePast });
  } catch (error) {
    c.fail('R4.51', `after deciding ${chosen}: ${message(error)}`);
    return c.outcome('');
  }
  const { data: after } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`);
  const body = after.body ?? '';
  const term = reflectedTerm(filedBody, body, pick.rule);
  c.check('R4.51', !bodyUnchanged(filedBody, body), `#${n} was shaped after deciding ${chosen}, but its body is unchanged`);
  c.check('R4.51', term !== undefined, `#${n}'s new body does not newly name ${pick.rule} after deciding ${chosen}: ${briefRecord(body)}`);
  return c.outcome(`#${n} stopped with a 產品決策 record of ${r.options.length} options; deciding ${chosen} made the next Shape write "${term ?? ''}" into the Issue and publish`);
}

/** Why the wait for the next Shape can no longer succeed: another agent stage ran before any new shape run. */
function unexpectedStage(k: Kit, s: Snapshot, n: number, removedAt: number): string | undefined {
  const runs = k.stages(s, k.exec, n, AGENT_STAGES).filter((r) => time(r.created_at) >= removedAt);
  const firstShape = runs.filter((r) => r.stage === 'shape').sort((a, b) => time(a.created_at) - time(b.created_at))[0];
  const other = runs.find((r) => r.stage !== 'shape' && (!firstShape || time(r.created_at) < time(firstShape.created_at)));
  return other ? `after pending was removed, a ${other.stage} run ${other.id} started (created ${other.created_at}) before any new shape run` : undefined;
}
