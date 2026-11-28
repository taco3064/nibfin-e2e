import { isDeepStrictEqual } from 'node:util';
import type { GitHub } from '../../src/host/github.ts';
import { branchProtection, rulesets } from '../../src/host/sandbox.ts';
import type { RunContext, Scenario } from '../../src/types.ts';
import { Check, message, tail } from '../lib/check.ts';
import { approvalRuleset } from '../lib/fixture.ts';
import { nibfinFacts, openPulls, registrations, whoami } from '../lib/github.ts';

export const FLOW_LABELS = ['request', 'scope', 'shaped', 'delivered', 'pause', 'pending'];

const labels = async (gh: GitHub, repo: string) =>
  (await gh.list<{ name: string }>(`/repos/${repo}/labels`)).map((l) => l.name);

async function volumes(ctx: RunContext): Promise<string[]> {
  const r = await ctx.exec(['podman', 'volume', 'ls', '--format', '{{.Name}}']);
  if (r.code !== 0) throw new Error(`podman volume ls exited ${r.code}: ${tail(r, 200)}`);
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/** Secret, variables and fork PR approval init sets on one repository (Proposal R5.35). */
async function prerequisites(c: Check, gh: GitHub, repo: string, visibility: 'public' | 'private'): Promise<void> {
  const r = `/repos/${repo}`;
  await c.part('R5.35', async () => {
    const s = await gh.rest('GET', `${r}/actions/secrets/NIBFIN_GITHUB_TOKEN`, undefined, [404]);
    c.that(s.status === 200, 'R5.35', `${repo} has no Actions secret NIBFIN_GITHUB_TOKEN`);
    const vars = await gh.list<{ name: string }>(`${r}/actions/variables`, 'variables');
    c.that(vars.length > 0, 'R5.35', `${repo} has no Actions variable`);
  });
  await c.part('R5.35', async () => {
    if (visibility === 'public') {
      const { data } = await gh.rest<{ approval_policy?: string }>(
        'GET',
        `${r}/actions/permissions/fork-pr-contributor-approval`,
      );
      c.that(
        data.approval_policy === 'all_external_contributors',
        'R5.35',
        `${repo} fork PR approval_policy is ${String(data.approval_policy)}, expected all_external_contributors`,
      );
    } else {
      const { data } = await gh.rest<{
        run_workflows_from_fork_pull_requests?: boolean;
        require_approval_for_fork_pr_workflows?: boolean;
      }>('GET', `${r}/actions/permissions/fork-pr-workflows-private-repos`);
      const ok =
        data.run_workflows_from_fork_pull_requests === false || data.require_approval_for_fork_pr_workflows === true;
      c.that(ok, 'R5.35', `${repo} runs fork PR workflows without approval (${JSON.stringify(data)})`);
    }
  });
}

/** The policy the drift step seeds on the execution sandbox; the `e2e-` prefix lets the fixture cleanup clear it too. */
const SEED = 'e2e-init-settings';

const MERGE_KEYS = ['allow_rebase_merge', 'allow_squash_merge', 'allow_merge_commit'] as const;
type MergeSettings = Partial<Record<(typeof MERGE_KEYS)[number], boolean>>;
const REBASE_ONLY = { allow_rebase_merge: true, allow_squash_merge: false, allow_merge_commit: false } as const;
const isRebaseOnly = (s: MergeSettings) => MERGE_KEYS.every((k) => s[k] === REBASE_ONLY[k]);
const mergeSettings = async (gh: GitHub, repo: string) => (await gh.rest<MergeSettings>('GET', `/repos/${repo}`)).data;

/** `init` allows only rebase merge (Proposal R5.67). */
async function rebaseOnly(c: Check, gh: GitHub, repo: string, when: string): Promise<void> {
  await c.part('R5.67', async () => {
    const s = await mergeSettings(gh, repo);
    for (const k of MERGE_KEYS)
      c.that(
        s[k] === REBASE_ONLY[k],
        'R5.67',
        `${repo}: ${k} is ${String(s[k])} ${when}, expected ${REBASE_ONLY[k]} (rebase merge only)`,
      );
  });
}

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}
interface RulesetDetail {
  id: number;
  name: string;
  target?: unknown;
  enforcement?: unknown;
  conditions?: unknown;
  rules?: Rule[];
}

const show = (v: unknown) => JSON.stringify(v) ?? 'undefined';
const without = (o: Record<string, unknown> | undefined, ...keys: string[]) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));

/** A copy without GitHub's `url` and `*_url` fields, which say nothing about the policy. */
function noUrls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(noUrls);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => k !== 'url' && !k.endsWith('_url'))
      .map(([k, x]) => [k, noUrls(x)]),
  );
}

/** The seeded ruleset after `init`, compared with its own read-back just before `init` (Proposal R5.68). */
function compareRuleset(c: Check, repo: string, before: RulesetDetail, after: RulesetDetail): void {
  const where = `${repo} ruleset ${SEED}`;
  for (const k of ['enforcement', 'target', 'conditions'] as const) {
    c.that(
      isDeepStrictEqual(after[k], before[k]),
      'R5.68',
      `${where}: ${k} was ${show(before[k])} before init and is ${show(after[k])} after; init must leave it unchanged`,
    );
  }
  const types = (rs: RulesetDetail) => (rs.rules ?? []).map((r) => r.type).sort();
  c.that(
    isDeepStrictEqual(types(after), types(before)),
    'R5.68',
    `${where}: rules were [${types(before).join(', ')}] before init and are [${types(after).join(', ')}] after; init must add or remove none`,
  );
  for (const b of before.rules ?? []) {
    const a = (after.rules ?? []).find((r) => r.type === b.type);
    if (!a) continue;
    if (b.type !== 'required_status_checks') {
      c.that(
        isDeepStrictEqual(a, b),
        'R5.68',
        `${where}: rule ${b.type} was ${show(b)} before init and is ${show(a)} after; init must leave it unchanged`,
      );
      continue;
    }
    const strict = a.parameters?.strict_required_status_checks_policy;
    c.that(
      strict === false,
      'R5.68',
      `${where}: strict_required_status_checks_policy was ${show(b.parameters?.strict_required_status_checks_policy)} before init and is ${show(strict)} after, expected false (up-to-date requirement off)`,
    );
    const rest = (r: Rule) => without(r.parameters, 'strict_required_status_checks_policy');
    c.that(
      isDeepStrictEqual(rest(a), rest(b)),
      'R5.68',
      `${where}: required_status_checks parameters other than the up-to-date requirement were ${show(rest(b))} before init and are ${show(rest(a))} after; init must leave them unchanged`,
    );
  }
}

/** Classic protection on main after `init`, compared with its own read-back just before `init` (Proposal R5.68). */
function compareProtection(
  c: Check,
  repo: string,
  before: Record<string, unknown>,
  after: Record<string, unknown> | undefined,
): void {
  const where = `${repo} branch protection on main`;
  if (
    !c.that(
      after !== undefined,
      'R5.68',
      `${where} was removed by init; init must only turn off the up-to-date requirement`,
    ) ||
    !after
  )
    return;
  const b = noUrls(before) as Record<string, unknown>;
  const a = noUrls(after) as Record<string, unknown>;
  const checksB = b.required_status_checks as Record<string, unknown> | undefined;
  const checksA = a.required_status_checks as Record<string, unknown> | undefined;
  c.that(
    checksA?.strict === false,
    'R5.68',
    `${where}: required_status_checks.strict was ${show(checksB?.strict)} before init and is ${show(checksA?.strict)} after, expected false (up-to-date requirement off)`,
  );
  c.that(
    isDeepStrictEqual(without(checksA, 'strict'), without(checksB, 'strict')),
    'R5.68',
    `${where}: required_status_checks other than strict were ${show(without(checksB, 'strict'))} before init and are ${show(without(checksA, 'strict'))} after; init must leave them unchanged`,
  );
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (k === 'required_status_checks') continue;
    c.that(
      isDeepStrictEqual(a[k], b[k]),
      'R5.68',
      `${where}: ${k} was ${show(b[k])} before init and is ${show(a[k])} after; init must leave it unchanged`,
    );
  }
}

/** The ruleset and branch-protection changes the drift step makes `init` apply, each of which its preview must name (Proposal R5.68). */
const PREVIEW_TERMS: [string, (out: string) => boolean][] = [
  [`the ruleset ${SEED}`, (o) => o.includes(SEED)],
  ['branch protection on main', (o) => /branch[ -]protection/i.test(o) && /\bmain\b/.test(o)],
  ['the up-to-date requirement', (o) => /up[ -]to[ -]date|strict/i.test(o)],
];

/**
 * Whether init's output names the change of merge methods to rebase only (Proposal R5.67), in whatever words init
 * uses (for example `allow merge methods rebase only`): some single line mentions `rebase` together with `merge`
 * or `only`.
 */
export function namesRebaseOnly(out: string): boolean {
  return out.split(/\r?\n/).some((line) => /\brebase\b/i.test(line) && /\b(?:merge|only)\b/i.test(line));
}

export const initSettings: Scenario = {
  id: 'init-settings',
  rules: [
    'R3.25',
    'R4.1',
    'R4.2',
    'R4.3',
    'R4.14',
    'R4.15',
    'R5.22',
    'R5.35',
    'R5.36',
    'R5.37',
    'R5.56',
    'R5.67',
    'R5.68',
  ],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const gh = ctx.github;
    const facts = nibfinFacts(ctx);
    const { execution, peer } = ctx.sandbox;
    const rule = (l: string) =>
      l === 'request' || l === 'scope' || l === 'shaped' || l === 'delivered'
        ? 'R4.1'
        : l === 'pause'
          ? 'R4.2'
          : 'R4.3';

    for (const repo of [execution, peer]) {
      const have = await labels(gh, repo);
      for (const l of FLOW_LABELS) c.that(have.includes(l), rule(l), `${repo} has no label ${l} after init`);
    }

    const inits = facts.commands.filter((x) => x.args[0] === 'init');
    for (const [repo, cmd] of [
      [execution, inits[0]],
      [peer, inits[1]],
    ] as const) {
      const link = `https://github.com/${repo}/settings`;
      c.that(
        !!cmd && (cmd.stdout + cmd.stderr).includes(link),
        'R4.15',
        `init for ${repo} does not print the settings link ${link}`,
      );
    }

    const me = await whoami(gh);
    for (const [repo, n] of [
      [execution, facts.executionPr],
      [peer, facts.peerPr],
    ] as const) {
      const { data } = await gh.rest<{ user: { login: string } }>('GET', `/repos/${repo}/pulls/${n}`);
      c.that(
        data.user.login === me.login,
        'R5.22',
        `${repo} init PR #${n} was opened by ${data.user.login}, expected the gh login ${me.login}`,
      );
    }

    const execRegs = await registrations(gh, execution);
    const peerRegs = await registrations(gh, peer);
    c.that(
      execRegs.length === facts.runnerCount && peerRegs.length === 0,
      'R5.56',
      `after init on both, ${execution} has ${execRegs.length} registrations (expected ${facts.runnerCount}) and ${peer} ${peerRegs.length} (expected 0)`,
    );
    c.that(
      execRegs.length > 0 && peerRegs.length === 0,
      'R5.37',
      `init chooses the execution or peer set by where the Runners are registered, but ${execution} has ${execRegs.length} and ${peer} ${peerRegs.length}`,
    );

    await prerequisites(c, gh, execution, 'public');
    await prerequisites(c, gh, peer, 'private');

    // The reset allows all three merge methods and leaves no ruleset or branch protection,
    // so rebase-only comes from the provisioning init, and init must have added no policy.
    for (const repo of [execution, peer]) await rebaseOnly(c, gh, repo, 'after the provisioning init');
    for (const repo of [execution, peer]) {
      await c.part('R5.68', async () => {
        const rs = await rulesets(gh, repo);
        c.that(
          !rs.length,
          'R5.68',
          `${repo} has ruleset ${rs.map((x) => x.name).join(', ')} after the provisioning init on a sandbox the reset left with none; init must add none`,
        );
        c.that(
          (await branchProtection(gh, repo)) === undefined,
          'R5.68',
          `${repo}: main has branch protection after the provisioning init on a sandbox the reset left with none; init must add none`,
        );
      });
    }

    // Drift on the execution repository, then init again: it converges and opens no PR.
    const r = `/repos/${execution}`;
    let seededId: number | undefined;
    let failure: unknown;
    try {
      await gh.rest('PATCH', r, {
        delete_branch_on_merge: true,
        pull_request_creation_policy: 'all',
        allow_squash_merge: true,
        allow_merge_commit: true,
      });
      await gh.rest('DELETE', `${r}/labels/request`, undefined, [404]);

      // A default-branch ruleset and classic protection that both require branches to be up to date, plus one more rule each.
      const base = approvalRuleset(SEED).body;
      const checks = {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: SEED }] },
      };
      seededId = (
        await gh.rest<{ id: number }>('POST', `${r}/rulesets`, { ...base, rules: [...(base.rules as Rule[]), checks] })
      ).data.id;
      await gh.rest('PUT', `${r}/branches/main/protection`, {
        required_status_checks: { strict: true, contexts: [SEED] },
        enforce_admins: null,
        required_pull_request_reviews: null,
        restrictions: null,
        required_linear_history: true,
      });
      const drifted = await mergeSettings(gh, execution);
      if (drifted.allow_squash_merge !== true || drifted.allow_merge_commit !== true)
        throw new Error(`seeding squash and merge commit on ${execution} did not take: ${show(drifted)}`);
      const rulesetBefore = (await gh.rest<RulesetDetail>('GET', `${r}/rulesets/${seededId}`)).data;
      const strictBefore = rulesetBefore.rules?.find((x) => x.type === 'required_status_checks')?.parameters
        ?.strict_required_status_checks_policy;
      if (strictBefore !== true)
        throw new Error(
          `seeding ruleset ${SEED} on ${execution} did not take: strict_required_status_checks_policy reads ${show(strictBefore)}`,
        );
      const protectionBefore = await branchProtection(gh, execution);
      const seeded = protectionBefore as
        { required_status_checks?: { strict?: unknown }; required_linear_history?: { enabled?: unknown } } | undefined;
      if (seeded?.required_status_checks?.strict !== true || seeded.required_linear_history?.enabled !== true) {
        throw new Error(
          `seeding branch protection on ${execution} main did not take: it reads ${show(protectionBefore)}`,
        );
      }
      const rulesetIdsBefore = (await rulesets(gh, execution)).map((x) => x.id).sort((a, b) => a - b);

      const regsBefore = (await registrations(gh, execution)).length;
      const volsBefore = await volumes(ctx);
      const prsBefore = (await openPulls(gh, execution)).map((p) => p.number);
      const again = await ctx.ghNibfin(['init', '--yes']);
      c.that(again.code === 0, 'R5.35', `init --yes on a drifted ${execution} exited ${again.code}: ${tail(again)}`);
      const { data } = await gh.rest<{ delete_branch_on_merge?: boolean; pull_request_creation_policy?: string }>(
        'GET',
        r,
      );
      c.that(
        data.pull_request_creation_policy === 'collaborators_only',
        'R4.14',
        `pull_request_creation_policy is ${String(data.pull_request_creation_policy)} after init, expected collaborators_only`,
      );
      c.that(
        data.delete_branch_on_merge === false,
        'R5.35',
        `delete_branch_on_merge is ${String(data.delete_branch_on_merge)} after init, expected false`,
      );
      c.that(
        (await labels(gh, execution)).includes('request'),
        'R5.35',
        'init did not recreate the deleted label request',
      );
      const prsAfter = (await openPulls(gh, execution)).map((p) => p.number).filter((n) => !prsBefore.includes(n));
      c.that(
        !prsAfter.length,
        'R5.35',
        `init on a repository whose main has the workflows opened PR ${prsAfter.map((n) => `#${n}`).join(', ')}`,
      );
      const regsAfter = (await registrations(gh, execution)).length;
      c.that(
        regsAfter === regsBefore,
        'R5.36',
        `init changed the runner registrations from ${regsBefore} to ${regsAfter}`,
      );
      const volsAfter = await volumes(ctx);
      c.that(
        volsAfter.join(',') === volsBefore.join(','),
        'R5.36',
        `init changed the Podman volumes from [${volsBefore.join(', ')}] to [${volsAfter.join(', ')}]`,
      );

      await rebaseOnly(c, gh, execution, 'after init --yes on a drift that re-enabled squash and merge commit');
      await c.part('R5.68', async () => {
        const rulesetAfter = (await gh.rest<RulesetDetail>('GET', `${r}/rulesets/${seededId}`)).data;
        compareRuleset(c, execution, rulesetBefore, rulesetAfter);
      });
      await c.part('R5.68', async () =>
        compareProtection(
          c,
          execution,
          protectionBefore as Record<string, unknown>,
          await branchProtection(gh, execution),
        ),
      );
      await c.part('R3.25', async () => {
        const idsAfter = (await rulesets(gh, execution)).map((x) => x.id).sort((a, b) => a - b);
        c.that(
          isDeepStrictEqual(idsAfter, rulesetIdsBefore),
          'R3.25',
          `init changed the rulesets of ${execution} from [${rulesetIdsBefore.join(', ')}] to [${idsAfter.join(', ')}]; it imposes no policy beyond its merge settings`,
        );
      });
      const out = again.stdout + again.stderr;
      for (const [change, named] of PREVIEW_TERMS)
        c.that(
          named(out),
          'R5.68',
          `the output of init --yes on ${execution} does not name the change to ${change}: ${tail(again)}`,
        );
      c.that(
        namesRebaseOnly(out),
        'R5.67',
        `the output of init --yes on ${execution} does not name the change of merge methods to rebase only: ${tail(again)}`,
      );
    } catch (error) {
      failure = error;
    }
    // Leave the repository as init set it, whatever happened above; the seeded policy goes first.
    const restore = async (): Promise<string[]> => {
      const ids = new Set((await rulesets(gh, execution)).filter((x) => x.name === SEED).map((x) => x.id));
      if (seededId !== undefined) ids.add(seededId);
      for (const id of ids) await gh.rest('DELETE', `${r}/rulesets/${id}`, undefined, [404]);
      if ((await branchProtection(gh, execution)) !== undefined)
        await gh.rest('DELETE', `${r}/branches/main/protection`);
      const { data } = await gh.rest<
        { delete_branch_on_merge?: boolean; pull_request_creation_policy?: string } & MergeSettings
      >('GET', r);
      if (
        data.delete_branch_on_merge !== false ||
        data.pull_request_creation_policy !== 'collaborators_only' ||
        !isRebaseOnly(data)
      ) {
        await gh.rest('PATCH', r, {
          delete_branch_on_merge: false,
          pull_request_creation_policy: 'collaborators_only',
          ...REBASE_ONLY,
        });
      }
      if (!(await labels(gh, execution)).includes('request')) await gh.rest('POST', `${r}/labels`, { name: 'request' });
      const left: string[] = [];
      for (const x of await rulesets(gh, execution))
        if (x.name === SEED || ids.has(x.id)) left.push(`ruleset ${x.name}`);
      if ((await branchProtection(gh, execution)) !== undefined) left.push('branch protection on main');
      return left;
    };
    const also = () => (failure === undefined ? '' : `; the step had also failed: ${message(failure)}`);
    let left: string[];
    try {
      left = await restore();
    } catch (error) {
      throw new Error(`restoring ${execution} after the drift step failed: ${message(error)}${also()}`, {
        cause: error,
      });
    }
    if (left.length)
      throw new Error(
        `removing the seeded policy from ${execution} did not stick: ${left.join(' and ')} remain${also()}`,
      );
    if (failure !== undefined) throw failure;
    return c.outcome(
      `labels, PR creation policy, rebase-only merge, settings link, Secret, variables and fork approval set on both sandboxes with no ruleset or protection added; a second init converged with no PR, restored rebase-only and turned off only the up-to-date requirement of a seeded ruleset and branch protection`,
    );
  },
};
