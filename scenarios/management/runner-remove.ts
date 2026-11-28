import { readHostState, readTask } from '../../src/host/hoststate.ts';
import type { HostRun } from '../../src/host/hoststate.ts';
import type { Scenario } from '../../src/types.ts';
import { Check, message, tail } from '../lib/check.ts';
import { parseRemaining } from '../lib/gh.ts';
import { nibfinFacts, openPulls, registrations } from '../lib/github.ts';
import type { StartTaskRecord, TaskSeen } from '../lib/github.ts';
import { finishHold, removeHold, startHold } from '../lib/hold.ts';
import { startsMachine } from '../lib/start-task.ts';
import { hostRun, newTasks, wslconfigChanges } from './runner-add-setup.ts';

/** Each task's actions and trigger kinds; a failed read is kept on that task and the others are still read. */
async function seen(run: HostRun, tasks: string[]): Promise<TaskSeen[]> {
  const out: TaskSeen[] = [];
  for (const name of tasks) {
    try {
      const d = await readTask(run, name);
      out.push({ name, actions: d.actions, triggers: d.triggers });
    } catch (error) {
      out.push({ name, error: message(error) });
    }
  }
  return out;
}

/** The task runs `podman machine start`, by the same match as the R5.12 and R5.13 scenarios. */
const isStart = (t: TaskSeen) => !!t.actions && t.actions.some(startsMachine);

export type StartTasks = { tasks: string[] } | { missing: 'unrecorded' | 'gone' | 'none' };

/**
 * The start tasks whose removal R5.16 checks: the one recorded right after runner add when
 * it is still `present`, first, then every other start task new since before runner add
 * (`fresh`), since the last removal must remove each of them. When there is none, it names
 * why: the recorded task is `gone`, the record found none (`unrecorded`), or there is no
 * usable record (`none`: no record, or only its read error).
 */
export function startTasksToCheck(o: { record?: StartTaskRecord; present: string[]; fresh: TaskSeen[] }): StartTasks {
  const tasks: string[] = [];
  const recorded = o.record?.task?.name;
  if (recorded !== undefined && o.present.includes(recorded)) tasks.push(recorded);
  for (const t of o.fresh) if (isStart(t) && !tasks.includes(t.name)) tasks.push(t.name);
  if (tasks.length) return { tasks };
  if (recorded !== undefined) return { missing: 'gone' };
  if (o.record && o.record.error === undefined) return { missing: 'unrecorded' };
  return { missing: 'none' };
}

/** A task for a reason: its name and actions (`execute arguments`), or its read error. */
export function describeTask(t: TaskSeen): string {
  if (t.error !== undefined) return `${t.name} (read error: ${t.error})`;
  const actions = (t.actions ?? []).map((a) => `${a.execute} ${a.arguments}`.trim());
  return `${t.name} (actions: ${actions.join('; ') || 'none'})`;
}

const describeAll = (ts: TaskSeen[]) => ts.map(describeTask).join(', ') || 'none';

/**
 * The R5.16 reason when no start task can be checked: which case it is and what was seen,
 * right after runner add (the record) and when runner-remove started (`fresh`, and the
 * podman-named tasks that existed before runner add, `older`).
 */
export function noStartTaskReason(o: {
  record?: StartTaskRecord;
  missing: 'unrecorded' | 'gone' | 'none';
  fresh: TaskSeen[];
  older: TaskSeen[];
}): string {
  const parts: string[] = [];
  const r = o.record;
  if (o.missing === 'gone' && r?.task)
    parts.push(
      `the recorded task ${describeTask(r.task)} was gone when runner-remove started; an earlier Runner removal may have removed it — file a new request to decide whether that is allowed (R5.16)`,
    );
  else if (o.missing === 'unrecorded')
    parts.push(`the record right after runner add found no such task (new tasks then: ${describeAll(r?.tasks ?? [])})`);
  else
    parts.push(
      r?.error !== undefined
        ? `the record right after runner add could not read the scheduled tasks: ${r.error}`
        : 'the nibfin provisioning step left no record of the tasks right after runner add',
    );
  for (const t of o.older.filter(isStart))
    parts.push(`a start task ${describeTask(t)} is present but existed before runner add, so it was not recorded or not new`);
  parts.push(`new since before runner add at runner-remove start: ${describeAll(o.fresh)}`);
  return `runner add's scheduled task that runs podman machine start cannot be checked for removal: ${parts.join('; ')}`;
}

/** Checks the command's own read-back of the remaining count (Proposal R5.32). */
function remaining(c: Check, stdout: string, expected: number, what: string): void {
  const r = parseRemaining(stdout);
  if (r.error) c.fail('R5.32', `${what}: the remaining-count read-back is ${r.error}`);
  else
    c.that(
      r.count === expected,
      'R5.32',
      `${what} reads back ${r.count === undefined ? 'no remaining count' : `remaining: ${r.count}`}, expected remaining: ${expected}`,
    );
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

    // The host after runner add, read before anything is removed. R5.16 names only
    // Windows here (scheduled task removed, .wslconfig kept); it names nothing on Linux.
    const windows = ctx.target.platform === 'windows';
    const setup = windows ? await readHostState(run, ctx.target.platform) : undefined;
    const before = facts.hostBefore.platform === 'windows' ? facts.hostBefore : undefined;
    const fresh = setup?.platform === 'windows' && before ? await seen(run, newTasks(before, setup)) : [];
    const found = startTasksToCheck({
      record: facts.startTask,
      present: setup?.platform === 'windows' ? setup.tasks : [],
      fresh,
    });
    // Diagnosis only, when nothing can be checked: start tasks that existed before runner add.
    // Filtered by name, since reading every scheduled task's detail is one host call per task.
    const older =
      'missing' in found && setup?.platform === 'windows' && before
        ? await seen(
            run,
            before.tasks.filter((t) => /podman/i.test(t) && setup.tasks.includes(t)),
          )
        : [];

    try {
      const hold = await startHold(gh, execution, 120);
      // Every Runner but one is removed while one is busy: the idle ones go first (R5.32), so only the busy one is left.
      const idle = String(facts.runnerCount - 1);
      const one = await ctx.ghNibfin(['runner', 'remove', 'claude', '--count', idle, '--yes']);
      c.that(one.code === 0, 'R5.31', `runner remove claude --count ${idle} --yes exited ${one.code}: ${tail(one)}`);
      remaining(c, one.stdout, 1, `runner remove --count ${idle}`);
      const left = await registrations(gh, execution);
      c.that(
        left.length === 1 && left[0]?.name === hold.runnerName,
        'R5.32',
        `after removing ${idle} of ${facts.runnerCount} Runners, ${execution} lists [${left.map((r) => r.name).join(', ')}]; expected only the busy ${hold.runnerName} (idle Runners go first)`,
      );

      const all = await ctx.ghNibfin(['runner', 'remove', 'claude', '--delete-login', '--yes']);
      c.that(all.code === 0, 'R5.31', `runner remove claude --delete-login --yes exited ${all.code}: ${tail(all)}`);
      remaining(c, all.stdout, 0, 'runner remove --delete-login');
      const conclusion = await finishHold(gh, execution, hold);
      c.that(
        conclusion === 'success',
        'R5.32',
        `the Job on the busy Runner ended ${conclusion}; removal must wait for it`,
      );
      const none = await registrations(gh, execution);
      c.that(
        none.length === 0,
        'R5.31',
        `after removing all Runners, ${execution} still lists [${none.map((r) => `${r.name} (${r.status})`).join(', ')}]`,
      );

      if (windows) await ctx.exec(['podman', 'machine', 'start']);
      const vols = await ctx.exec(['podman', 'volume', 'ls', '--format', '{{.Name}}']);
      c.that(
        vols.code === 0 &&
          !vols.stdout
            .split('\n')
            .map((s) => s.trim())
            .includes('nibfin-home-claude'),
        'R6.23',
        `the login volume nibfin-home-claude ${vols.code === 0 ? 'still exists' : `cannot be listed (${tail(vols, 200)})`} after --delete-login`,
      );

      if (windows) {
        const now = await readHostState(run, ctx.target.platform);
        if (setup?.platform !== 'windows' || now.platform !== 'windows')
          c.fail('R5.16', 'the Windows host state could not be read to check the last removal');
        else {
          if ('tasks' in found) {
            const still = found.tasks.filter((t) => now.tasks.includes(t));
            c.that(!still.length, 'R5.16', `the last Runner's removal left the scheduled task ${still.join(', ')}`);
          } else c.fail('R5.16', noStartTaskReason({ record: facts.startTask, missing: found.missing, fresh, older }));
          const w = wslconfigChanges(setup.wslconfig, now.wslconfig);
          c.that(
            !w.changed.length,
            'R5.16',
            `the last Runner's removal changed or removed .wslconfig keys (kept unchanged since runner add): ${w.changed.join(', ')}`,
          );
          c.that(
            !w.added.length,
            'R5.16',
            `the last Runner's removal added .wslconfig keys (kept unchanged since runner add): ${w.added.join(', ')}`,
          );
        }
      }

      // R5.36: init needs local Runners; it installs none and logs nothing in.
      const prs = (await openPulls(gh, peer)).map((p) => p.number);
      const init = await ctx.ghNibfin(['init', '-R', peer, '--yes']);
      c.that(init.code !== 0, 'R5.36', `init -R ${peer} without local Runners exited 0: ${tail(init, 300)}`);
      const newPrs = (await openPulls(gh, peer)).map((p) => p.number).filter((n) => !prs.includes(n));
      c.that(!newPrs.length, 'R5.36', `init without local Runners opened PR ${newPrs.map((n) => `#${n}`).join(', ')}`);
      c.that(
        (await registrations(gh, execution)).length === 0,
        'R5.36',
        'init without local Runners registered a Runner',
      );
    } finally {
      await removeHold(gh, execution);
    }
    const host = windows ? ', removed the podman machine start scheduled task and kept .wslconfig unchanged' : '';
    return c.outcome(
      `runner remove took the ${facts.runnerCount - 1} idle Runner(s) first, waited for the busy one, read back 1 then 0, deleted the login volume${host}; init then refused`,
    );
  },
};
