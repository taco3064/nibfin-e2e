import { readHostState, readTask } from '../../src/host/hoststate.ts';
import type { HostRun } from '../../src/host/hoststate.ts';
import type { Scenario } from '../../src/types.ts';
import { Check, tail } from '../lib/check.ts';
import { parseRemaining } from '../lib/gh.ts';
import { nibfinFacts, openPulls, registrations } from '../lib/github.ts';
import { finishHold, removeHold, startHold } from '../lib/hold.ts';
import { hostRun, newEnabledUnits, newTasks } from './runner-add-setup.ts';

/** The new scheduled tasks that run `podman machine start` (other tasks may appear on the host meanwhile). */
async function podmanStartTasks(run: HostRun, tasks: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of tasks) {
    const d = await readTask(run, t);
    if (d.actions.some((a) => /podman/i.test(a.execute) && /\bmachine\s+start\b/.test(a.arguments))) out.push(t);
  }
  return out;
}

/** Checks the command's own read-back of the remaining count (Proposal R5.32). */
function remaining(c: Check, stdout: string, expected: number, what: string): void {
  const r = parseRemaining(stdout);
  if (r.error) c.fail('R5.32', `${what}: the remaining-count read-back is ${r.error}`);
  else c.that(r.count === expected, 'R5.32', `${what} reads back ${r.count === undefined ? 'no remaining count' : `remaining: ${r.count}`}, expected remaining: ${expected}`);
}

/**
 * Destructive: removes every local Runner and the login volume, so it runs last. The
 * `nibfin` teardown then finds no Runner left.
 */
export const runnerRemove: Scenario = {
  id: 'runner-remove',
  rules: ['R5.31', 'R5.32', 'R5.16', 'R5.36', 'R6.23'],
  platforms: ['linux', 'windows'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const gh = ctx.github;
    const { execution, peer } = ctx.sandbox;
    const facts = nibfinFacts(ctx);
    const run = hostRun(ctx);

    // What the always-on setup added, read before anything is removed.
    const setup = await readHostState(run, ctx.target.platform);
    const added =
      setup.platform === 'linux' && facts.hostBefore.platform === 'linux'
        ? newEnabledUnits(facts.hostBefore, setup)
        : setup.platform === 'windows' && facts.hostBefore.platform === 'windows'
          ? await podmanStartTasks(run, newTasks(facts.hostBefore, setup))
          : [];

    const hold = await startHold(gh, execution, 120);
    try {
      const one = await ctx.ghNibfin(['runner', 'remove', 'claude', '--count', '1', '--yes']);
      c.that(one.code === 0, 'R5.31', `runner remove claude --count 1 --yes exited ${one.code}: ${tail(one)}`);
      remaining(c, one.stdout, 1, 'runner remove --count 1');
      const left = await registrations(gh, execution);
      c.that(
        left.length === 1 && left[0]?.name === hold.runnerName,
        'R5.32',
        `after removing one Runner, ${execution} lists [${left.map((r) => r.name).join(', ')}]; expected only the busy ${hold.runnerName} (idle Runners go first)`,
      );

      const all = await ctx.ghNibfin(['runner', 'remove', 'claude', '--delete-login', '--yes']);
      c.that(all.code === 0, 'R5.31', `runner remove claude --delete-login --yes exited ${all.code}: ${tail(all)}`);
      remaining(c, all.stdout, 0, 'runner remove --delete-login');
      const conclusion = await finishHold(gh, execution, hold);
      c.that(conclusion === 'success', 'R5.32', `the Job on the busy Runner ended ${conclusion}; removal must wait for it`);
      const none = await registrations(gh, execution);
      c.that(none.length === 0, 'R5.31', `after removing all Runners, ${execution} still lists [${none.map((r) => `${r.name} (${r.status})`).join(', ')}]`);

      if (ctx.target.platform === 'windows') await ctx.exec(['podman', 'machine', 'start']);
      const vols = await ctx.exec(['podman', 'volume', 'ls', '--format', '{{.Name}}']);
      c.that(vols.code === 0 && !vols.stdout.split('\n').map((s) => s.trim()).includes('nibfin-home-claude'), 'R6.23', `the login volume nibfin-home-claude ${vols.code === 0 ? 'still exists' : `cannot be listed (${tail(vols, 200)})`} after --delete-login`);

      const now = await readHostState(run, ctx.target.platform);
      const still = now.platform === 'linux' ? added.filter((u) => now.units.some((x) => x.name === u)) : now.platform === 'windows' ? added.filter((t) => now.tasks.includes(t)) : [];
      c.that(added.length > 0, 'R5.16', `runner add's always-on setup could not be found to check its removal (no new ${ctx.target.platform === 'windows' ? 'scheduled task' : 'user unit'} against the host before runner add)`);
      c.that(!still.length, 'R5.16', `the last Runner's removal left the autostart setup ${still.join(', ')}`);

      // R5.36: init needs local Runners; it installs none and logs nothing in.
      const prs = (await openPulls(gh, peer)).map((p) => p.number);
      const init = await ctx.ghNibfin(['init', '-R', peer, '--yes']);
      c.that(init.code !== 0, 'R5.36', `init -R ${peer} without local Runners exited 0: ${tail(init, 300)}`);
      const newPrs = (await openPulls(gh, peer)).map((p) => p.number).filter((n) => !prs.includes(n));
      c.that(!newPrs.length, 'R5.36', `init without local Runners opened PR ${newPrs.map((n) => `#${n}`).join(', ')}`);
      c.that((await registrations(gh, execution)).length === 0, 'R5.36', 'init without local Runners registered a Runner');
    } finally {
      await removeHold(gh, execution);
    }
    return c.outcome(`runner remove took the idle Runner first, waited for the busy one, read back 1 then 0, deleted the login volume and the autostart setup; init then refused`);
  },
};
