// What the scenarios look for in Nibfin's comments and job logs. The Proposal fixes no
// log wording for a Validator verdict, the Accept check or a route's report, so these
// patterns are deliberately loose; a log that shows none of them fails the scenario
// as a product finding ("nothing observable"), not as a harness error.

const VALIDATOR_SUBJECT = String.raw`\bvalidat(?:or|ion|ed|es|e|ing)s?\b`;
const VALIDATOR_RESULT = String.raw`\b(?:approv\w*|pass\w*|verdict|accept\w*|ok)\b`;
/**
 * A Shape Validator verdict in a `shape` job log (Proposal R3.13, R3.40): a Validator
 * subject (`validator`, `validation`, `validated`, `validate`, `validating`) and a result
 * word on one line, in either order. The leading word boundary keeps `invalidate` and
 * `revalidated` out; a bare subject or a bare result word does not count.
 */
export const VALIDATOR_VERDICT = new RegExp(
  `${VALIDATOR_SUBJECT}.*${VALIDATOR_RESULT}|${VALIDATOR_RESULT}.*${VALIDATOR_SUBJECT}`,
  'i',
);

/** The start and end of the Accept check inside a `deliver` job log (Proposal R3.19, R6.5). */
export const ACCEPT_START = /\baccept(or|ance)?\b.*\b(start\w*|begin\w*|running|launch\w*|review\w*)\b/i;
export const ACCEPT_END = /\baccept(or|ance)?\b.*\b(pass\w*|approv\w*|verdict|done|finish\w*|complete\w*|defects?)\b/i;

/**
 * A route's explicit report of an open blocker or a missing Assignee (Proposal R3.32).
 * Besides free wordings such as `blocked by #4` or `no assignee`, they accept Core's route
 * lines `nothing to run (ineligible (blocked))` and `nothing to run (ineligible (no-assignee))`.
 * A bare `blocked` is not enough on its own, so `not blocked` or `unblocked` do not count.
 */
export const BLOCKER_REPORT = /\b(blocked\s*by|blocker|blocking|dependenc(y|ies))\b|\bineligible\s*\(\s*blocked\s*\)/i;
export const NO_ASSIGNEE_REPORT = /\b(no|without|missing)[\s-]+assignees?\b|\bassignees?\b.*\b(none|missing|empty)\b/i;

/** The single Shape comment (marker `<!-- nibfin:shape… -->`). */
export const SHAPE_MARKER = /^shape\b/;

/** The re-login command a failed-login comment names (Proposal R6.13). */
export const RELOGIN = /gh nibfin login/;

/** A PR comment saying the merge waits for an approving review (Proposal R3.26), not just any review comment. */
export const AWAITS_REVIEW =
  /\b(wait\w*|await\w*|requir\w*|need\w*)\b[\s\S]*\bapprov\w*|\bapprov\w*[\s\S]*\b(wait\w*|await\w*|requir\w*|need\w*|missing)\b/i;

/** The `pending` comment (marker `<!-- nibfin:pending -->`). */
export const PENDING_MARKER = /^pending\b/;
