// What the scenarios look for in Nibfin's comments and job logs. The Proposal fixes no
// log wording for a Validator verdict, the Accept check or a route's report, so these
// patterns are deliberately loose; a log that shows none of them fails the scenario
// as a product finding ("nothing observable"), not as a harness error.

/** A Shape Validator verdict in a `shape` job log (Proposal R3.13, R3.40). */
export const VALIDATOR_VERDICT = /\bvalidat(or|ion)\b.*\b(approv\w*|pass\w*|verdict|accept\w*|ok)\b/i;

/** The start and end of the Accept check inside a `deliver` job log (Proposal R3.19, R6.5). */
export const ACCEPT_START = /\baccept(or|ance)?\b.*\b(start\w*|begin\w*|running|launch\w*|review\w*)\b/i;
export const ACCEPT_END = /\baccept(or|ance)?\b.*\b(pass\w*|approv\w*|verdict|done|finish\w*|complete\w*|defects?)\b/i;

/** A route's explicit report of an open blocker or a missing Assignee (Proposal R3.32). */
export const BLOCKER_REPORT = /\b(blocked\s*by|blocker|blocking|dependenc(y|ies))\b/i;
export const NO_ASSIGNEE_REPORT = /\b(no|without|missing)\s+assignees?\b|\bassignees?\b.*\b(none|missing|empty)\b/i;

/** The single Shape comment (marker `<!-- nibfin:shape… -->`). */
export const SHAPE_MARKER = /^shape\b/;

/** The re-login command a failed-login comment names (Proposal R6.13). */
export const RELOGIN = /gh nibfin login/;

/** A PR comment saying the merge waits for an approving review (Proposal R3.26). */
export const AWAITS_REVIEW = /\b(review|approv\w*)\b/i;
