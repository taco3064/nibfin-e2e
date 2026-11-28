// The `request` / Scope stage (Proposal R3.2–R3.10, R4.8). Reported `waiting` until
// Core delivers the stage (Proposal R8.20).
import type { GitHub } from '../../src/host/github.ts';
import type { Outcome, Scenario } from '../../src/types.ts';
import { Checks, describeComments, findListing, markerOf, refersToIssue, time } from './analysis.ts';
import type { Comment, Issue } from './analysis.ts';
import { DEADLINE, lifecycle } from './kit.ts';
import type { Kit } from './kit.ts';
import type { Snapshot } from './observe.ts';

/** The Issues that deliver the Scope stage (the Proposal's R3.2–R3.11 record). */
export const SCOPE_ISSUES: [string, number][] = [
  ['taco3064/nibfin-core', 732],
  ['taco3064/nibfin-core', 733],
  ['taco3064/nibfin-core', 734],
  ['taco3064/nibfin-core', 735],
  ['taco3064/nibfin-core', 736],
  ['taco3064/gh-nibfin', 420],
];

/** `waiting` naming the Scope Issues not yet closed with `delivered`, or undefined when all are. */
export async function scopeGate(gh: GitHub): Promise<Outcome | undefined> {
  const open: string[] = [];
  for (const [repo, n] of SCOPE_ISSUES) {
    const { data } = await gh.rest<Issue>('GET', `/repos/${repo}/issues/${n}`);
    if (!(data.state === 'closed' && data.labels.some((l) => l.name === 'delivered'))) open.push(`${repo}#${n}`);
  }
  return open.length
    ? {
        status: 'waiting',
        reason: `the Scope stage is not delivered yet: ${open.join(', ')} not closed with delivered`,
      }
    : undefined;
}

function requestScenario(id: string, rules: string[], body: (k: Kit, filed: number[]) => Promise<Outcome>): Scenario {
  return lifecycle({
    id,
    rules,
    concurrent: true,
    async run(k) {
      const gate = await scopeGate(k.gh);
      if (gate) return gate;
      const filed: number[] = [];
      try {
        return await body(k, filed);
      } finally {
        await k.pauseOpen(k.exec, filed);
      }
    },
  });
}

/**
 * Waits for an infeasible request to stop (Proposal R3.9): first for `pending` on it,
 * with the stall check, as Scope should be active until then; then for a Nibfin-marked
 * comment, read directly from GitHub on each try and `quiet`, as after `pending` the
 * request waits for a person by design. Step B's failure names the comments it read.
 */
/** Why the waits for an infeasible request's stop do not end on `pending`: it is how the request stops (Proposal R3.9). */
const INFEASIBLE_PENDING = 'an infeasible request stops with pending';

export async function awaitInfeasibleStop(
  k: Kit,
  repo: string,
  n: number,
  show: (s: Snapshot) => Promise<string>,
): Promise<void> {
  await k.obs.until(
    'the request to get pending',
    (s) => (k.labels(s, repo, n).includes('pending') ? true : undefined),
    DEADLINE.stage,
    show,
    {
      ...k.about(repo, n),
      expects: { pending: INFEASIBLE_PENDING },
      gonePast: (s) => {
        const i = k.issue(s, repo, n);
        return i?.state === 'closed' ? `#${n} was closed (${String(i.state_reason)}) before it got pending` : undefined;
      },
    },
  );
  let read: Comment[] = [];
  await k.obs.until(
    'a Nibfin comment on the request',
    async () => {
      read = await k.gh.list<Comment>(`/repos/${repo}/issues/${n}/comments`);
      return read.some((c) => markerOf(c.body)) ? true : undefined;
    },
    DEADLINE.event,
    async (s) => `${await show(s).catch(() => '')}; ${describeComments(read)}`,
    { ...k.about(repo, n), expects: { pending: INFEASIBLE_PENDING }, quiet: true },
  );
}

const FIXTURE = '_This Issue is an automated nibfin-e2e fixture._';

export const requestInfeasible = requestScenario(
  'request-infeasible',
  ['R3.2', 'R3.3', 'R3.9', 'R3.10', 'R4.8'],
  async (k, filed) => {
    const c = new Checks();
    const { exec } = k;
    const owner = await k.owner();
    const r = await k.file(exec, {
      scenario: 'request-infeasible',
      title: 'Rotate the NIBFIN_GITHUB_TOKEN secret',
      body: `Please rotate this repository's \`NIBFIN_GITHUB_TOKEN\` Actions secret to a new token.\n\n${FIXTURE}`,
      labels: ['request', 'pause'],
      assignees: [owner.login],
    });
    filed.push(r.number);
    const n = r.number;
    const show = k.show(exec, n);
    const paused = await k.settle('the paused request', k.now(), k.runsOf(exec, n));
    c.check('R4.8', k.stages(paused, exec, n, ['scope']).length === 0, 'a paused request got a scope run');
    await k.removeLabel(exec, n, 'pause');
    await awaitInfeasibleStop(k, exec, n, show);
    const s = await k.obs.fresh();
    c.check('R3.2', k.stages(s, exec, n, ['scope']).length > 0, 'the request never reached the Scope stage');
    c.check(
      'R3.3',
      !(s.issues.get(exec) ?? []).some((i) => i.body?.includes(`Origin: ${r.html_url}`)),
      'an infeasible request published Issues',
    );
    c.check('R3.9', k.issue(s, exec, n)?.state === 'open', 'the infeasible request was closed');
    await k.removeLabel(exec, n, 'pending');
    const removed = k.now();
    await k.obs.until(
      'a new scope run after pending was removed',
      (s2) => k.stages(s2, exec, n, ['scope']).find((x) => time(x.created_at) >= removed),
      DEADLINE.stage,
      show,
      k.about(exec, n),
    );
    return c.outcome(
      `request #${n} needing Secrets stopped with pending, stayed open, and reran Scope once pending was removed`,
    );
  },
);

export const requestFeasible = requestScenario(
  'request-feasible',
  ['R3.2', 'R3.3', 'R3.4', 'R3.5', 'R3.6'],
  async (k, filed) => {
    const c = new Checks();
    const { exec } = k;
    const owner = await k.owner();
    const slug = k.slug('max');
    const r = await k.file(exec, {
      scenario: 'request-feasible',
      title: 'Add max',
      body: `Please add a \`max(a, b)\` function in \`src/${slug}.js\` that returns the larger of two numbers, with a test.\n\n${FIXTURE}`,
      labels: ['request'],
      assignees: [owner.login],
    });
    filed.push(r.number);
    const n = r.number;
    const origin = (i: Issue) =>
      i.number !== n && !!i.body && i.body.split('\n').some((l) => l.includes('Origin:') && refersToIssue(l, exec, n));
    const closed = await k.obs.until(
      'the request to close',
      async (s) => {
        for (const i of (s.issues.get(exec) ?? []).filter(origin)) {
          if (!filed.includes(i.number)) {
            filed.push(i.number);
            await k.addLabels(exec, i.number, ['pause']);
          }
        }
        return k.issue(s, exec, n)?.state === 'closed' ? s : undefined;
      },
      DEADLINE.delivery,
      k.show(exec, n),
      k.about(exec, n),
    );
    const published = (closed.issues.get(exec) ?? []).filter(origin);
    c.check('R3.2', k.stages(closed, exec, n, ['scope']).length > 0, 'the request never reached the Scope stage');
    c.check('R3.3', published.length > 0, 'the feasible request published no Issue');
    c.check(
      'R3.4',
      published.every((i) => i.body?.includes('Origin:')),
      'a published Issue has no Origin:',
    );
    const lastCreated = Math.max(...published.map((i) => time(i.created_at)));
    for (const i of published) {
      c.check(
        'R3.5',
        i.labels.some((l) => l.name === 'scope'),
        `#${i.number} has no scope`,
      );
      c.check(
        'R3.5',
        i.assignees.map((a) => a.login).join() === r.assignees.map((a) => a.login).join(),
        `#${i.number} has Assignees ${i.assignees.map((a) => a.login).join(', ')}, not the request's`,
      );
      const scoped = (await k.obs.timeline(exec, i.number)).find(
        (e) => e.event === 'labeled' && e.label?.name === 'scope',
      );
      c.check(
        'R3.5',
        !!scoped && time(scoped.created_at) >= lastCreated,
        `#${i.number} got scope before every published Issue existed`,
      );
      await k.obs.blockedBy(exec, i.number);
    }
    const listing = findListing(
      await k.obs.comments(exec, n),
      exec,
      published.map((i) => i.number),
    );
    c.check('R3.6', !!listing, 'no comment on the request lists every published Issue');
    c.check(
      'R3.6',
      k.issue(closed, exec, n)?.state_reason === 'completed',
      `the request closed as ${String(k.issue(closed, exec, n)?.state_reason)}, expected completed`,
    );
    return c.outcome(
      `request #${n} published ${published.map((i) => `#${i.number}`).join(', ')} and closed as completed`,
    );
  },
);

export const requestAlreadyDone = requestScenario('request-already-done', ['R3.8'], async (k, filed) => {
  const c = new Checks();
  const { exec } = k;
  const owner = await k.owner();
  const r = await k.file(exec, {
    scenario: 'request-already-done',
    title: 'Add sum',
    body: `Please add a \`sum(a, b)\` function in \`src/sum.js\` that returns the sum of two numbers, with a test.\n\n${FIXTURE}`,
    labels: ['request'],
    assignees: [owner.login],
  });
  filed.push(r.number);
  const closed = await k.obs.until(
    'the request to close',
    (s) => (k.issue(s, exec, r.number)?.state === 'closed' ? s : undefined),
    DEADLINE.stage,
    k.show(exec, r.number),
    k.about(exec, r.number),
  );
  c.check(
    'R3.8',
    k.issue(closed, exec, r.number)?.state_reason === 'not_planned',
    `the request closed as ${String(k.issue(closed, exec, r.number)?.state_reason)}, expected not_planned`,
  );
  c.check(
    'R3.8',
    (await k.obs.comments(exec, r.number)).some((x) => markerOf(x.body)),
    'no comment explains why',
  );
  return c.outcome(`request #${r.number} for the existing sum closed as not planned with a comment`);
});
