import type { GitHub } from '../../src/host/github.ts';
import type { RunContext, Scenario } from '../../src/types.ts';
import { Check, tail } from '../lib/check.ts';
import { nibfinFacts, openPulls, registrations, whoami } from '../lib/github.ts';

export const FLOW_LABELS = ['request', 'scope', 'shaped', 'delivered', 'pause', 'pending'];

const labels = async (gh: GitHub, repo: string) => (await gh.list<{ name: string }>(`/repos/${repo}/labels`)).map((l) => l.name);

async function volumes(ctx: RunContext): Promise<string[]> {
  const r = await ctx.exec(['podman', 'volume', 'ls', '--format', '{{.Name}}']);
  if (r.code !== 0) throw new Error(`podman volume ls exited ${r.code}: ${tail(r, 200)}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
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
      const { data } = await gh.rest<{ approval_policy?: string }>('GET', `${r}/actions/permissions/fork-pr-contributor-approval`);
      c.that(data.approval_policy === 'all_external_contributors', 'R5.35', `${repo} fork PR approval_policy is ${String(data.approval_policy)}, expected all_external_contributors`);
    } else {
      const { data } = await gh.rest<{ run_workflows_from_fork_pull_requests?: boolean; require_approval_for_fork_pr_workflows?: boolean }>(
        'GET',
        `${r}/actions/permissions/fork-pr-workflows-private-repos`,
      );
      const ok = data.run_workflows_from_fork_pull_requests === false || data.require_approval_for_fork_pr_workflows === true;
      c.that(ok, 'R5.35', `${repo} runs fork PR workflows without approval (${JSON.stringify(data)})`);
    }
  });
}

export const initSettings: Scenario = {
  id: 'init-settings',
  rules: ['R4.1', 'R4.2', 'R4.3', 'R4.14', 'R4.15', 'R5.22', 'R5.35', 'R5.36', 'R5.37', 'R5.56'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const gh = ctx.github;
    const facts = nibfinFacts(ctx);
    const { execution, peer } = ctx.sandbox;
    const rule = (l: string) => (l === 'request' || l === 'scope' || l === 'shaped' || l === 'delivered' ? 'R4.1' : l === 'pause' ? 'R4.2' : 'R4.3');

    for (const repo of [execution, peer]) {
      const have = await labels(gh, repo);
      for (const l of FLOW_LABELS) c.that(have.includes(l), rule(l), `${repo} has no label ${l} after init`);
    }

    const inits = facts.commands.filter((x) => x.args[0] === 'init');
    for (const [repo, cmd] of [[execution, inits[0]], [peer, inits[1]]] as const) {
      const link = `https://github.com/${repo}/settings`;
      c.that(!!cmd && (cmd.stdout + cmd.stderr).includes(link), 'R4.15', `init for ${repo} does not print the settings link ${link}`);
    }

    const me = await whoami(gh);
    for (const [repo, n] of [[execution, facts.executionPr], [peer, facts.peerPr]] as const) {
      const { data } = await gh.rest<{ user: { login: string } }>('GET', `/repos/${repo}/pulls/${n}`);
      c.that(data.user.login === me.login, 'R5.22', `${repo} init PR #${n} was opened by ${data.user.login}, expected the gh login ${me.login}`);
    }

    const execRegs = await registrations(gh, execution);
    const peerRegs = await registrations(gh, peer);
    c.that(execRegs.length === 2 && peerRegs.length === 0, 'R5.56', `after init on both, ${execution} has ${execRegs.length} registrations (expected 2) and ${peer} ${peerRegs.length} (expected 0)`);
    c.that(
      execRegs.length > 0 && peerRegs.length === 0,
      'R5.37',
      `init chooses the execution or peer set by where the Runners are registered, but ${execution} has ${execRegs.length} and ${peer} ${peerRegs.length}`,
    );

    await prerequisites(c, gh, execution, 'public');
    await prerequisites(c, gh, peer, 'private');

    // Drift on the execution repository, then init again: it converges and opens no PR.
    const r = `/repos/${execution}`;
    try {
      await gh.rest('PATCH', r, { delete_branch_on_merge: true, pull_request_creation_policy: 'all' });
      await gh.rest('DELETE', `${r}/labels/request`, undefined, [404]);
      const regsBefore = (await registrations(gh, execution)).length;
      const volsBefore = await volumes(ctx);
      const prsBefore = (await openPulls(gh, execution)).map((p) => p.number);
      const again = await ctx.ghNibfin(['init', '--yes']);
      c.that(again.code === 0, 'R5.35', `init --yes on a drifted ${execution} exited ${again.code}: ${tail(again)}`);
      const { data } = await gh.rest<{ delete_branch_on_merge?: boolean; pull_request_creation_policy?: string }>('GET', r);
      c.that(data.pull_request_creation_policy === 'collaborators_only', 'R4.14', `pull_request_creation_policy is ${String(data.pull_request_creation_policy)} after init, expected collaborators_only`);
      c.that(data.delete_branch_on_merge === false, 'R5.35', `delete_branch_on_merge is ${String(data.delete_branch_on_merge)} after init, expected false`);
      c.that((await labels(gh, execution)).includes('request'), 'R5.35', 'init did not recreate the deleted label request');
      const prsAfter = (await openPulls(gh, execution)).map((p) => p.number).filter((n) => !prsBefore.includes(n));
      c.that(!prsAfter.length, 'R5.35', `init on a repository whose main has the workflows opened PR ${prsAfter.map((n) => `#${n}`).join(', ')}`);
      const regsAfter = (await registrations(gh, execution)).length;
      c.that(regsAfter === regsBefore, 'R5.36', `init changed the runner registrations from ${regsBefore} to ${regsAfter}`);
      const volsAfter = await volumes(ctx);
      c.that(volsAfter.join(',') === volsBefore.join(','), 'R5.36', `init changed the Podman volumes from [${volsBefore.join(', ')}] to [${volsAfter.join(', ')}]`);
    } finally {
      // Leave the repository as init set it, whatever happened above.
      const { data } = await gh.rest<{ delete_branch_on_merge?: boolean; pull_request_creation_policy?: string }>('GET', r);
      if (data.delete_branch_on_merge !== false || data.pull_request_creation_policy !== 'collaborators_only') {
        await gh.rest('PATCH', r, { delete_branch_on_merge: false, pull_request_creation_policy: 'collaborators_only' });
      }
      if (!(await labels(gh, execution)).includes('request')) await gh.rest('POST', `${r}/labels`, { name: 'request' });
    }
    return c.outcome(`labels, PR creation policy, settings link, Secret, variables and fork approval set on both sandboxes; a second init converged with no PR`);
  },
};
