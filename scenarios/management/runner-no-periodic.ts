import {
  hostPeriodicRun,
  readHostState,
  readPeriodic,
  readTask,
  readVmPeriodic,
  userRuntimeDir,
} from '../../src/host/hoststate.ts';
import type { Baseline, CronState, Periodic, TaskDetail } from '../../src/host/hoststate.ts';
import type { Scenario } from '../../src/types.ts';
import { Check } from '../lib/check.ts';
import { nibfinFacts } from '../lib/github.ts';
import { hostRun, newTasks } from './runner-add-setup.ts';

type Unit = { name: string; state: string };

/** `.timer` unit files, in any state, that were not there before runner add. */
export function newTimerUnits(before: Unit[], now: Unit[]): Unit[] {
  const had = new Set(before.map((u) => u.name));
  return now.filter((u) => u.name.endsWith('.timer') && !had.has(u.name));
}

/**
 * Timers `list-timers` shows now that were neither listed before nor a unit file before: a
 * transient timer counts, an image timer only loaded once the user manager started does not.
 */
export function newTimers(before: { timers: string[]; units: { name: string }[] }, now: string[]): string[] {
  const had = new Set([...before.timers, ...before.units.map((u) => u.name)]);
  return now.filter((t) => !had.has(t));
}

/** Cron lines added since before runner add, or why the two reads cannot be compared; `evidence` when cron is absent both times. */
export function newCronEntries(before: CronState, now: CronState): { problems: string[]; evidence?: string } {
  if (before.available && now.available) {
    const had = new Set(before.entries);
    return { problems: now.entries.filter((e) => !had.has(e)).map((e) => `the crontab gained the entry "${e}"`) };
  }
  if (!before.available) {
    if (!now.available)
      return { problems: [], evidence: `cron not installed before (${before.evidence}) or after (${now.evidence})` };
    return {
      problems: [
        `cron was not installed before runner add (${before.evidence}) and is now, with the entries [${now.entries.map((e) => `"${e}"`).join(', ')}]`,
      ],
    };
  }
  const evidence = now.available ? '' : now.evidence;
  return {
    problems: [
      `the crontab was readable before runner add but cron now reads as not installed (${evidence}); the reads disagree`,
    ],
  };
}

const ALLOWED_TRIGGERS = ['MSFT_TaskLogonTrigger', 'MSFT_TaskEventTrigger'];
const noRepetition = (interval: string | null | undefined) =>
  interval === undefined || interval === null || interval.trim() === '' || interval.trim() === 'PT0S';

/** A task's triggers that are not logon or event triggers, or that repeat; a repetition list that does not match the triggers is unreadable. */
export function periodicTriggers(detail: TaskDetail): string[] {
  const out: string[] = [];
  if (detail.repetitions.length !== detail.triggers.length) {
    out.push(
      `its trigger repetitions could not be read (${detail.repetitions.length} for ${detail.triggers.length} triggers)`,
    );
  }
  detail.triggers.forEach((t, i) => {
    if (!ALLOWED_TRIGGERS.includes(t)) out.push(`trigger ${t} is neither a logon nor an event trigger`);
    const interval = detail.repetitions[i];
    if (!noRepetition(interval)) out.push(`trigger ${t} repeats every ${interval}`);
  });
  return out;
}

/** User units in the VM that runner add added: the positive control that the read reached the Runners' user manager. */
export function newVmUnits(before: Unit[], now: Unit[]): string[] {
  const had = new Set(before.map((u) => u.name));
  return now.filter((u) => !had.has(u.name)).map((u) => u.name);
}

function baseline(b: Baseline<Periodic> | undefined, where: string): Periodic {
  if (b === undefined) throw new Error(`hostBefore has no periodic baseline${where}`);
  if ('error' in b) throw new Error(`the periodic baseline${where} could not be read before runner add: ${b.error}`);
  return b;
}

const list = (xs: string[]) => xs.join(', ') || 'none';

/** Compares one scope's periodic mechanisms with its baseline; returns the cron evidence when cron is absent. */
function comparePeriodic(
  c: Check,
  prefix: string,
  before: { units: Unit[]; timers: string[]; cron: CronState },
  now: Periodic,
): string | undefined {
  for (const u of newTimerUnits(before.units, now.units))
    c.fail('R5.17', `${prefix}runner add added the timer unit ${u.name} (${u.state})`);
  for (const t of newTimers(before, now.timers))
    c.fail('R5.17', `${prefix}list-timers --all lists the timer ${t}, which was not there before runner add`);
  const cron = newCronEntries(before.cron, now.cron);
  for (const p of cron.problems) c.fail('R5.17', `${prefix}${p}`);
  return cron.evidence;
}

export const runnerNoPeriodic: Scenario = {
  id: 'runner-no-periodic',
  rules: ['R5.17'],
  platforms: ['linux', 'windows'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const facts = nibfinFacts(ctx);
    const run = hostRun(ctx);
    const before = facts.hostBefore;
    const notes: string[] = [];

    if (ctx.target.platform === 'linux') {
      await c.part('R5.17', async () => {
        if (before.platform !== 'linux') throw new Error(`hostBefore is for ${before.platform}, not linux`);
        const base = baseline(before.periodic, '');
        // After runner add the user manager must run (R5.15), so no read may fall back.
        const now = await readPeriodic(hostPeriodicRun(run, userRuntimeDir()), { noManagerOk: false });
        const units = base.manager ? base.units : before.units;
        const cron = comparePeriodic(c, '', { units, timers: base.timers, cron: base.cron }, now);
        notes.push(
          `host: ${now.timers.length} timers and ${now.cron.available ? `${now.cron.entries.length} crontab lines` : 'no cron'} compared${cron ? ` (${cron})` : ''}`,
        );
      });
    }

    if (ctx.target.platform === 'windows') {
      await c.part('R5.17', async () => {
        if (before.platform !== 'windows') throw new Error(`hostBefore is for ${before.platform}, not windows`);
        const now = await readHostState(run, 'windows');
        if (now.platform !== 'windows') throw new Error('the Windows host state could not be read');
        const tasks = newTasks(before, now);
        for (const t of tasks) {
          let detail: TaskDetail;
          try {
            detail = await readTask(run, t);
          } catch (error) {
            c.fail(
              'R5.17',
              `scheduled task ${t} could not be read: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          const actions = detail.actions.map((a) => `${a.execute} ${a.arguments}`.trim()).join('; ') || 'none';
          for (const f of periodicTriggers(detail)) c.fail('R5.17', `scheduled task ${t} (actions: ${actions}): ${f}`);
        }
        notes.push(`${tasks.length} new scheduled tasks checked for time, idle and repeating triggers`);
      });

      await c.part('R5.17', async () => {
        if (before.platform !== 'windows') throw new Error(`hostBefore is for ${before.platform}, not windows`);
        const base = baseline(before.vm, ' of the podman machine VM');
        // runner add started the machine (R5.27) and the Runners run in it (R5.10).
        const now = await readVmPeriodic(run);
        const added = newVmUnits(base.units, now.units);
        if (!added.length) {
          c.fail(
            'R5.17',
            `podman machine VM: the ssh session lists no user unit that runner add added; the read did not reach the Runners' user manager (R5.10) ` +
              `(before: ${list(base.units.map((u) => u.name))}; now: ${list(now.units.map((u) => u.name))})`,
          );
          return;
        }
        const cron = comparePeriodic(c, 'podman machine VM: ', base, now);
        notes.push(
          `VM units added: ${added.join(', ')}; ${now.timers.length} VM timers and ${now.cron.available ? `${now.cron.entries.length} VM crontab lines` : 'no VM cron'} compared${cron ? ` (${cron})` : ''}`,
        );
      });
    }

    return c.outcome(
      `no new timer, cron entry or periodic scheduled task since before runner add; ${notes.join('; ')}`,
    );
  },
};
