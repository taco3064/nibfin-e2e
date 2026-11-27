import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseIni, readHostState, readTask, userRuntimeDir } from '../../src/host/hoststate.ts';
import type { HostRun, LinuxHostState, WindowsHostState } from '../../src/host/hoststate.ts';
import type { RunContext, Scenario } from '../../src/types.ts';
import { Check, tail } from '../lib/check.ts';
import { parseHelp } from '../lib/gh.ts';
import { nibfinFacts, registrations, whoami } from '../lib/github.ts';

export const hostRun = (ctx: RunContext): HostRun => (argv, env) => ctx.exec(argv, { env });

/** Enabled user units that were not there before runner add. */
export function newEnabledUnits(before: LinuxHostState, now: LinuxHostState): string[] {
  const had = new Set(before.units.map((u) => u.name));
  return now.units.filter((u) => u.state === 'enabled' && !had.has(u.name)).map((u) => u.name);
}

export const newTasks = (before: WindowsHostState, now: WindowsHostState) => now.tasks.filter((t) => !before.tasks.includes(t));

/** `.wslconfig` changes: keys whose value changed or vanished, and keys that appeared. */
export function wslconfigChanges(before: string | null, now: string | null): { changed: string[]; added: string[]; now: Record<string, Record<string, string>> } {
  const a = parseIni(before);
  const b = parseIni(now);
  const changed: string[] = [];
  const added: string[] = [];
  for (const [s, keys] of Object.entries(a)) for (const [k, v] of Object.entries(keys)) if (b[s]?.[k] !== v) changed.push(`[${s}] ${k}`);
  for (const [s, keys] of Object.entries(b)) for (const k of Object.keys(keys)) if (a[s]?.[k] === undefined) added.push(`[${s}] ${k}`);
  return { changed, added, now: b };
}

/** Finds a program on the host PATH (argv-only `which`). */
async function which(ctx: RunContext, program: string): Promise<string> {
  const r = await ctx.exec(['which', program]);
  const p = r.stdout.trim().split('\n')[0];
  if (r.code !== 0 || !p) throw new Error(`${program} is not on the host PATH`);
  return p;
}

export const runnerAddSetup: Scenario = {
  id: 'runner-add-setup',
  rules: ['R5.25', 'R5.26', 'R5.27', 'R5.28', 'R5.29', 'R5.13', 'R5.15'],
  platforms: ['linux', 'windows'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const facts = nibfinFacts(ctx);
    const { execution, peer } = ctx.sandbox;

    const order = facts.commands.map((x) => x.args.slice(0, 2).join(' '));
    c.that(
      order[0] === 'runner add' && order[1] === 'init --yes' && order[2] === `init -R` && facts.commands.slice(0, 3).every((x) => x.code === 0),
      'R5.25',
      `expected runner add, then init, then init -R ${peer}, each exiting 0; saw ${facts.commands.map((x) => `${x.args.join(' ')} → ${x.code}`).join(', ')}`,
    );

    const me = await whoami(ctx.github);
    const label = `nibfin-${me.id}`;
    const regs = await registrations(ctx.github, execution);
    c.that(regs.length === 2, 'R5.26', `${execution} lists ${regs.length} runner registrations after runner add claude --count 2, expected 2`);
    for (const r of regs) {
      c.that(r.status === 'online', 'R5.26', `registration ${r.name} is ${r.status}, expected online`);
      c.that(r.labels.some((l) => l.name === label), 'R5.29', `registration ${r.name} lacks the label ${label} (labels: ${r.labels.map((l) => l.name).join(', ')})`);
    }
    const peerRegs = await registrations(ctx.github, peer);
    c.that(peerRegs.length === 0, 'R5.29', `${peer} lists ${peerRegs.length} runner registrations; Runners must register only to the directory's repository ${execution}`);

    await c.part('R5.26', async () => {
      const help = await ctx.ghNibfin(['runner', 'add', '--help']);
      const count = parseHelp(help.stdout).flags.find((f) => f.name === 'count');
      c.that(help.code === 0 && count?.default === '2', 'R5.26', `runner add --help shows --count with default ${count?.default ?? 'none'}, expected 2 (${tail(help, 200)})`);
    });

    const run = hostRun(ctx);
    const now = await readHostState(run, ctx.target.platform);
    if (now.platform === 'linux' && facts.hostBefore.platform === 'linux') {
      const before = facts.hostBefore;
      const units = newEnabledUnits(before, now);
      c.that(units.length >= 2, 'R5.15', `expected at least 2 new enabled systemd user units after runner add, found ${units.length} (${units.join(', ') || 'none'})`);
      for (const u of units) {
        const runtime = userRuntimeDir();
        const a = await ctx.exec(['systemctl', '--user', 'is-active', u], runtime === undefined ? {} : { env: { XDG_RUNTIME_DIR: runtime } });
        c.that(a.stdout.trim() === 'active', 'R5.15', `user unit ${u} is ${a.stdout.trim() || `not active (${tail(a, 100)})`}`);
      }
      c.that(now.linger === 'yes', 'R5.15', `Linger is "${now.linger}" for the host user, expected yes`);
      const sysAdded = now.systemFiles.filter((f) => !before.systemFiles.includes(f));
      const sysGone = before.systemFiles.filter((f) => !now.systemFiles.includes(f));
      c.that(!sysAdded.length && !sysGone.length, 'R5.28', `/etc/systemd/system changed: added ${sysAdded.join(', ') || 'nothing'}, removed ${sysGone.join(', ') || 'nothing'}`);

      await c.part('R5.27', async () => {
        // A PATH with gh (and git, which gh may need to find the repository) but no Podman.
        const bin = ctx.workPath('no-podman-bin');
        rmSync(bin, { recursive: true, force: true });
        mkdirSync(bin, { recursive: true });
        for (const p of ['gh', 'git']) symlinkSync(await which(ctx, p), join(bin, p));
        const r = await ctx.ghNibfin(['runner', 'add', 'claude', '--count', '1', '--yes'], { env: { PATH: bin } });
        c.that(r.code !== 0, 'R5.27', `runner add without Podman on PATH exited 0 (${tail(r, 300)})`);
        c.that(/podman/i.test(r.stdout + r.stderr), 'R5.27', `runner add without Podman does not name Podman: ${tail(r, 300)}`);
        const after = await registrations(ctx.github, execution);
        c.that(after.length === 2, 'R5.27', `runner add without Podman changed the registrations to ${after.length}, expected 2`);
      });
    }
    if (now.platform === 'windows' && facts.hostBefore.platform === 'windows') {
      const before = facts.hostBefore;
      await c.part('R5.27', async () => {
        const r = await ctx.exec(['podman', 'machine', 'inspect']);
        const state = r.code === 0 ? (JSON.parse(r.stdout) as { State?: string }[])[0]?.State : undefined;
        c.that(state === 'running', 'R5.27', `podman machine is ${state ?? `not readable (${tail(r, 200)})`} after runner add, expected running`);
      });
      const w = wslconfigChanges(before.wslconfig, now.wslconfig);
      c.that(w.now.wsl2?.vmidletimeout === '-1', 'R5.13', `.wslconfig [wsl2] vmIdleTimeout is ${w.now.wsl2?.vmidletimeout ?? 'absent'}, expected -1`);
      const changedOther = w.changed.filter((k) => k !== '[wsl2] vmidletimeout');
      c.that(!changedOther.length, 'R5.13', `.wslconfig settings that existed before runner add changed: ${changedOther.join(', ')}`);
      const addedOther = w.added.filter((k) => k !== '[wsl2] vmidletimeout');
      c.that(!addedOther.length, 'R5.28', `runner add wrote other .wslconfig settings: ${addedOther.join(', ')}`);

      const tasks = newTasks(before, now);
      const details = await Promise.all(tasks.map(async (t) => ({ t, d: await readTask(run, t) })));
      const starter = details.find(({ d }) => d.actions.some((a) => /podman(\.exe)?"?$/i.test(a.execute.trim()) && /\bmachine\s+start\b/.test(a.arguments)));
      if (c.that(!!starter, 'R5.13', `no new scheduled task runs podman machine start (new tasks: ${tasks.join(', ') || 'none'})`) && starter) {
        const logon = starter.d.triggers.includes('MSFT_TaskLogonTrigger');
        const other = starter.d.triggers.some((t) => t !== 'MSFT_TaskLogonTrigger');
        c.that(logon && other, 'R5.13', `task ${starter.t} triggers are ${starter.d.triggers.join(', ') || 'none'}; expected a logon trigger and one for resume from sleep`);
      }
    }
    return c.outcome(`2 Runners online on ${execution} with ${label}; always-on setup applied on ${ctx.target.platform}`);
  },
};
