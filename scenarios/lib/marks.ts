// The hidden marker keys the scenarios look for in Nibfin's comments.

/**
 * The Shape comment's marker key, loosely (marker `<!-- nibfin:shape… -->`). The word
 * boundary also matches keys that begin with `shape-` or `shape:`, such as Core's
 * `shape-wrong` report.
 */
export const SHAPE_MARKER = /^shape\b/;

/** The `pending` comment (marker `<!-- nibfin:pending -->`). */
export const PENDING_MARKER = /^pending\b/;
