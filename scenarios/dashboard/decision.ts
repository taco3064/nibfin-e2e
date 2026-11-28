// The product-decision fixture of the Dashboard resolution scenario: an Issue that leaves how
// halves round to the Owner, so Shape stops with `pending` for a product decision
// (Proposal R4.45, R4.51), and the wait for that stop.
import type { Issue } from '../lib/analysis.ts';
import { DEADLINE } from '../lib/issue-kit.ts';
import type { FixtureSpec, Kit } from '../lib/issue-kit.ts';
import type { Snapshot } from '../lib/observer.ts';

/** A request for a few-line change with its own test, in files only this fixture touches. */
function changeRequest(slug: string, fn: string, behaviour: string, extra = ''): string {
  return [
    `Add \`src/${slug}.js\` exporting a function \`${fn}\` that ${behaviour}, and a \`node:test\` test for it in \`test/${slug}.test.js\`.`,
    'Keep the change to these two files.',
    extra,
    '_This Issue is an automated nibfin-e2e fixture._',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The fixture's open product choice, left explicitly to the Owner. It names no rounding rule. */
const DECISION_EXTRA =
  'How exact halves round (for example 2.5 and -2.5) is an open product decision that the Owner has not made yet. Do not choose a rule yourself and do not implement until the Owner has decided; stop and ask the Owner, giving the possible rules and their consequences.';

/** The fixture body for the files under `src/<slug>.js`; it names no rounding rule. */
export function decisionBody(slug: string): string {
  return changeRequest(slug, 'roundHalf(x)', 'rounds a number to the nearest integer', DECISION_EXTRA);
}

/** The product-decision fixture: `scope`, the Owner as Assignee. */
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

/** Why the waits for a product-decision stop and its record do not end on `pending`: it is how Shape stops for the decision (Proposal R4.45). */
const DECISION_PENDING = 'Shape stops with pending for the product decision';

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
      ...k.about(k.exec, n),
      expects: { pending: DECISION_PENDING },
      gonePast: async (s) =>
        k.labels(s, k.exec, n).includes('shaped')
          ? `#${n}: Shape was published without stopping: the agent chose the rounding itself`
          : gone(s),
    },
  );
}
