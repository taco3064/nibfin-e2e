import type { ExecResult } from '../../src/host/exec.ts';
import { MINUTE_MS } from '../../src/host/github.ts';
import { readHostState, readTask } from '../../src/host/hoststate.ts';
import type { HostRun } from '../../src/host/hoststate.ts';
import { describeLimit, readCoreLimit, waitForCoreLimit } from '../../src/host/ratelimit.ts';
import type { CoreLimit } from '../../src/host/ratelimit.ts';
import type { Outcome, Scenario } from '../../src/types.ts';
import { Check, message, precondition, redact, tail } from '../lib/check.ts';
import { parseRemaining } from '../lib/gh.ts';
import { nibfinFacts, openPulls, registrations } from '../lib/github.ts';
import type { StartTaskRecord, TaskSeen } from '../lib/github.ts';
import { finishHold, removeHold, startHold } from '../lib/hold.ts';
import { startsMachine } from '../lib/start-task.ts';
import { sleep } from '../lib/wait.ts';
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

/** A `runner remove` that exited non-zero, with the core limit read right after it (or that read's error). */
export interface RemoveFailure {
  result: ExecResult;
  limit?: CoreLimit;
  limitError?: string;
  /** How many times the command ran; 2 after the one rerun. */
  tries: number;
}

/**
 * One `runner remove` command: `ok` when it exited 0 (`retried` keeps the rate-limited
 * first try when only the rerun passed), `rateLimited` when it failed under a GitHub rate
 * limit (its output names one, or the core limit read right after shows none left), and
 * `failed` otherwise.
 */
export type RemoveResult =
  | { ok: ExecResult; retried?: RemoveFailure }
  | { rateLimited: RemoveFailure }
  | { failed: RemoveFailure };

export interface RemoveDeps {
  ghNibfin(args: string[]): Promise<ExecResult>;
  readLimit(): Promise<CoreLimit>;
  /** Waits for the core reset when little is left; reports how long it waited. */
  waitForLimit(): Promise<{ waitedMs: number }>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

async function classify(deps: RemoveDeps, result: ExecResult, tries: number): Promise<RemoveResult> {
  if (result.code === 0) return { ok: result };
  const f: RemoveFailure = { result, tries };
  try {
    f.limit = await deps.readLimit();
  } catch (error) {
    f.limitError = message(error);
  }
  const limited = /rate limit/i.test(`${result.stdout}\n${result.stderr}`) || f.limit?.remaining === 0;
  return limited ? { rateLimited: f } : { failed: f };
}

/**
 * Runs one `runner remove` and classifies it. With `rerun`, a rate-limited try is run once
 * more after waiting: for the core reset when little is left, otherwise one minute, since
 * the limit hit was then a secondary one. Only a command that is safe to repeat after a
 * partial removal may set `rerun`.
 */
export async function removeStep(deps: RemoveDeps, args: string[], rerun: boolean): Promise<RemoveResult> {
  const first = await classify(deps, await deps.ghNibfin(args), 1);
  if (!rerun || !('rateLimited' in first)) return first;
  deps.log(`gh nibfin ${args.join(' ')} failed under a GitHub rate limit; waiting for the limit, then running it once more`);
  if ((await deps.waitForLimit()).waitedMs === 0) await deps.sleep(MINUTE_MS);
  const second = await classify(deps, await deps.ghNibfin(args), 2);
  return 'ok' in second ? { ok: second.ok, retried: first.rateLimited } : second;
}

const limitText = (f: RemoveFailure) =>
  f.limit ? describeLimit(f.limit) : `the limit could not be read (${f.limitError ?? 'no read'})`;

/**
 * The one not-reached entry for the checks that depend on a failed `runner remove`: the
 * command's own failure, the limit read right after it, and the checks left out.
 */
export function notReachedEntry(command: string, r: Exclude<RemoveResult, { ok: ExecResult }>, left: string[]): string {
  const f = 'rateLimited' in r ? r.rateLimited : r.failed;
  const tries = f.tries > 1 ? ` (on its rerun after a rate-limited try)` : '';
  const why =
    'rateLimited' in r
      ? `failed under a GitHub rate limit${tries}, exiting ${f.result.code}: ${tail(f.result, 400)}`
      : `failed${tries} while the limit had room, exiting ${f.result.code} (the R5.31 failure)`;
  return `${command} ${why}; limit read after it: ${limitText(f)}; so these checks were not reached: ${left.join(', ')}`;
}

/**
 * The scenario's outcome from its rule problems and its not-reached entries: rule problems
 * only as `Check` gives them, entries only as a precondition not reached, and both as
 * `failed` with the problems first and the entries after, without a rule id.
 */
export function removeOutcome(c: Check, notReached: string[], summary: string): Outcome {
  if (!notReached.length) return c.outcome(summary);
  if (!c.problems.length) return precondition(notReached.join('; '));
  return {
    status: 'failed',
    reason: `${c.problems.join('; ')}; precondition not reached: ${redact(notReached.join('; '))}`,
  };
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

    const notReached: string[] = [];
    let retriedNote = '';
    const deps: RemoveDeps = {
      ghNibfin: (args) => ctx.ghNibfin(args),
      readLimit: () => readCoreLimit(gh),
      waitForLimit: () => waitForCoreLimit(gh, { log: ctx.log, what: 'running gh nibfin runner remove again' }),
      sleep,
      log: ctx.log,
    };
    // Waited for here, before the 120 s hold Job starts, so the wait inside the first
    // remove normally finds room and cannot outlast the busy Job (R5.32 idle-first).
    await waitForCoreLimit(gh, { log: ctx.log, what: 'the busy hold Job and gh nibfin runner remove' });

    try {
      const hold = await startHold(gh, execution, 120);
      // Every Runner but one is removed while one is busy: the idle ones go first (R5.32), so only the busy one is left.
      // Not rerun: after a partial removal, the same --count could take the busy Runner.
      const idle = String(facts.runnerCount - 1);
      const oneCmd = `runner remove claude --count ${idle} --yes`;
      const one = await removeStep(deps, ['runner', 'remove', 'claude', '--count', idle, '--yes'], false);
      if ('ok' in one) {
        remaining(c, one.ok.stdout, 1, `runner remove --count ${idle}`);
        const left = await registrations(gh, execution);
        c.that(
          left.length === 1 && left[0]?.name === hold.runnerName,
          'R5.32',
          `after removing ${idle} of ${facts.runnerCount} Runners, ${execution} lists [${left.map((r) => r.name).join(', ')}]; expected only the busy ${hold.runnerName} (idle Runners go first)`,
        );
      } else {
        if ('failed' in one) c.fail('R5.31', `${oneCmd} exited ${one.failed.result.code}: ${tail(one.failed.result)}`);
        notReached.push(
          notReachedEntry(oneCmd, one, [
            'its read-back of remaining: 1 (R5.32)',
            'only the busy Runner registered, idle ones first (R5.32)',
          ]),
        );
      }

      // Removes every Runner, so it and its checks do not depend on the first removal.
      // Safe to run again after a partial removal, so a rate-limited try is rerun once.
      const allCmd = 'runner remove claude --delete-login --yes';
      const all = await removeStep(deps, ['runner', 'remove', 'claude', '--delete-login', '--yes'], true);
      if (!('ok' in all)) {
        if ('failed' in all) c.fail('R5.31', `${allCmd} exited ${all.failed.result.code}: ${tail(all.failed.result)}`);
        // Nothing below runs: with local Runners left, init could even open a PR on the peer sandbox.
        notReached.push(
          notReachedEntry(allCmd, all, [
            "its read-back of remaining: 0 and the busy Job's conclusion (R5.32)",
            'no Runner registered (R5.31)',
            'the login volume deleted (R6.23)',
            ...(windows ? ['the start task removed and .wslconfig kept (R5.16)'] : []),
            'init refused without local Runners (R5.36)',
          ]),
        );
        return removeOutcome(c, notReached, '');
      }
      if (all.retried) retriedNote = `; ${allCmd} passed on its rerun after one rate-limited try`;
      remaining(c, all.ok.stdout, 0, 'runner remove --delete-login');
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
    return removeOutcome(
      c,
      notReached,
      `runner remove took the ${facts.runnerCount - 1} idle Runner(s) first, waited for the busy one, read back 1 then 0, deleted the login volume${host}; init then refused${retriedNote}`,
    );
  },
};
