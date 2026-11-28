import { untilAborted } from '../../src/abort.ts';
import type { ExecResult } from '../../src/host/exec.ts';
import { readHostState, readTask, userRuntimeDir } from '../../src/host/hoststate.ts';
import type { HostRun, HostState, WindowsHostState } from '../../src/host/hoststate.ts';
import type { RunContext, Scenario } from '../../src/types.ts';
import { Check, message, precondition, tail } from '../lib/check.ts';
import { nibfinFacts, registrations } from '../lib/github.ts';
import type { NibfinFacts, Registration } from '../lib/github.ts';
import { startTask } from '../lib/start-task.ts';
import { sleep, waitFor } from '../lib/wait.ts';
import { hostRun, newEnabledUnits, newTasks } from './runner-add-setup.ts';

// Proposal R5.12: `podman machine` must not depend on the terminal or program that started
// it. Windows: the machine outlives the provisioning `runner add` and the R5.13 start task.
// Linux has no machine (R5.10): the Runners' units run under the user manager, not a session.

const RULE = 'R5.12';
/** Task Scheduler: SCHED_S_TASK_RUNNING and SCHED_S_TASK_HAS_NOT_RUN. */
const TASK_RUNNING = 0x41301;
const TASK_HAS_NOT_RUN = 0x41303;
/** How long the Runner services inside the VM get to start and reconnect after the task ended. */
export const SETTLE_MS = 120_000;

export const hex = (n: number | undefined) => (n === undefined ? 'none' : `0x${n.toString(16)}`);

// ---- Windows: the scheduled task's run state ----

export interface TaskRun {
  state: string;
  lastRunTime: string;
  lastResult: number | undefined;
}

/** The `{state, lastRunTime, lastResult}` object the task-run read prints; throws naming the text otherwise. */
export function parseTaskRun(stdout: string): TaskRun {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`task run state is not JSON: ${stdout.trim().slice(0, 300) || 'empty output'}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof (v as { state?: unknown }).state !== 'string') {
    throw new Error(`task run state has no state: ${stdout.trim().slice(0, 300)}`);
  }
  const o = v as { state: string; lastRunTime?: unknown; lastResult?: unknown };
  return {
    state: o.state,
    lastRunTime: typeof o.lastRunTime === 'string' ? o.lastRunTime : '',
    lastResult: typeof o.lastResult === 'number' && Number.isFinite(o.lastResult) ? o.lastResult : undefined,
  };
}

/** The task ran since `before` and has ended: not running or queued, a new run time, and a final last result. */
export function taskEnded(run: TaskRun, before: TaskRun): boolean {
  const state = run.state.toLowerCase();
  if (state === 'running' || state === 'queued') return false;
  if (run.lastRunTime === '' || run.lastRunTime === before.lastRunTime) return false;
  return run.lastResult !== undefined && run.lastResult !== TASK_RUNNING && run.lastResult !== TASK_HAS_NOT_RUN;
}

// ---- Windows: process snapshots ----

export interface Proc {
  pid: number;
  ppid: number;
  name: string;
  created: string;
}

export interface Snapshot {
  /** The PowerShell process that took the snapshot. */
  self: number;
  procs: Proc[];
}

/** One `Win32_Process` snapshot; entries without a numeric pid are skipped, a missing `procs` array throws. */
export function parseProcesses(stdout: string): Snapshot {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`process snapshot is not JSON: ${stdout.trim().slice(0, 300) || 'empty output'}`);
  }
  const o = (v && typeof v === 'object' ? v : {}) as { self?: unknown; procs?: unknown };
  if (!Array.isArray(o.procs)) throw new Error(`process snapshot has no procs array: ${stdout.trim().slice(0, 300)}`);
  const procs: Proc[] = [];
  for (const x of o.procs as unknown[]) {
    const p = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (typeof p.pid !== 'number' || !Number.isFinite(p.pid)) continue;
    procs.push({
      pid: p.pid,
      ppid: typeof p.ppid === 'number' ? p.ppid : -1,
      name: typeof p.name === 'string' ? p.name : '',
      created: typeof p.created === 'string' ? p.created : '',
    });
  }
  return { self: typeof o.self === 'number' ? o.self : -1, procs };
}

const time = (s: string) => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};

/** Whether `parent` was created after `child`, so it reuses the pid of the child's real, ended parent (Win32_Process). */
function createdAfter(parent: Proc, child: Proc): boolean {
  const a = time(parent.created);
  const b = time(child.created);
  return a !== undefined && b !== undefined && a > b;
}

export interface Stranded extends Proc {
  why: string;
}

/**
 * Processes alive in `after`, not in `before`, that still depend on the ended task: a
 * console host (`conhost.exe`, `OpenConsole.exe`) whose opener is gone, and any new
 * `podman.exe`. The snapshot's own process and its direct children are not counted.
 */
export function strandedConsoles(before: Snapshot, after: Snapshot): Stranded[] {
  const had = new Set(before.procs.map((p) => `${p.pid}|${p.created}`));
  const byPid = new Map(after.procs.map((p) => [p.pid, p]));
  const out: Stranded[] = [];
  for (const p of after.procs) {
    if (had.has(`${p.pid}|${p.created}`) || p.pid === after.self || p.ppid === after.self) continue;
    const name = p.name.toLowerCase();
    const parent = byPid.get(p.ppid);
    const gone = !parent || createdAfter(parent, p);
    if ((name === 'conhost.exe' || name === 'openconsole.exe') && gone)
      out.push({ ...p, why: 'a console whose opener is gone' });
    else if (name === 'podman.exe')
      out.push({ ...p, why: `a podman.exe still alive (parent ${gone ? 'gone' : (parent?.name ?? '?')})` });
  }
  return out;
}

/** `podman machine inspect`'s first machine state; throws when it cannot be read. */
export function machineState(stdout: string): string {
  const v: unknown = JSON.parse(stdout.trim());
  const state = Array.isArray(v) ? (v[0] as { State?: unknown } | undefined)?.State : undefined;
  if (typeof state !== 'string') throw new Error(`podman machine inspect has no State: ${stdout.trim().slice(0, 300)}`);
  return state;
}

// ---- Linux ----

/** `KEY=VALUE` lines of `systemctl show`. */
export function parseUnitShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Undefined when the unit is active in a cgroup under `user@<uid>.service` and not in a login session scope; otherwise the problem. */
export function unitDetached(props: Record<string, string>, uid: number): string | undefined {
  const active = props.ActiveState ?? '';
  const cg = props.ControlGroup ?? '';
  const inSession = cg.split('/').some((part) => /^session-.+\.scope$/.test(part));
  const underManager = (cg + '/').includes(`/user@${uid}.service/`);
  if (active === 'active' && underManager && !inSession) return undefined;
  const where = inSession ? 'a login session' : `not under user@${uid}.service`;
  return `is ${active || 'of unknown state'} in ${cg || 'no control group'}${active === 'active' ? `, ${where}` : ''}`;
}

/** Names of the `podman machine list --format json` entries that run. */
export function runningMachines(stdout: string): string[] {
  const v: unknown = JSON.parse(stdout.trim());
  if (!Array.isArray(v)) throw new Error(`podman machine list is not a JSON array: ${stdout.trim().slice(0, 300)}`);
  return v
    .filter((m) => (m as { Running?: unknown })?.Running === true)
    .map((m) => String((m as { Name?: unknown }).Name ?? '?'));
}

// ---- host reads ----

const PS = ['powershell', '-NoProfile', '-NonInteractive', '-Command'];

const TASK_RUN =
  '$t = Get-ScheduledTask -TaskPath $env:NIBFIN_E2E_TASK_PATH -TaskName $env:NIBFIN_E2E_TASK_NAME; ' +
  '$i = Get-ScheduledTaskInfo -TaskPath $env:NIBFIN_E2E_TASK_PATH -TaskName $env:NIBFIN_E2E_TASK_NAME; ' +
  "@{ state = [string]$t.State; lastRunTime = if ($i.LastRunTime) { $i.LastRunTime.ToString('o') } else { '' }; lastResult = [int64]$i.LastTaskResult } | ConvertTo-Json -Compress";

const START_TASK = 'Start-ScheduledTask -TaskPath $env:NIBFIN_E2E_TASK_PATH -TaskName $env:NIBFIN_E2E_TASK_NAME';

const SNAPSHOT =
  '@{ self = $PID; procs = @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int64]$_.ProcessId; ppid = [int64]$_.ParentProcessId; name = [string]$_.Name; ' +
  "created = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' } } }) } | ConvertTo-Json -Compress -Depth 3";

const taskEnv = (fullName: string) => {
  const cut = fullName.lastIndexOf('\\') + 1;
  return { NIBFIN_E2E_TASK_PATH: fullName.slice(0, cut), NIBFIN_E2E_TASK_NAME: fullName.slice(cut) };
};

const failed = (what: string, r: ExecResult) => new Error(`${what} exited ${r.code}: ${tail(r, 400)}`);

async function readTaskRun(run: HostRun, task: string): Promise<TaskRun> {
  const r = await run([...PS, TASK_RUN], taskEnv(task));
  if (r.code !== 0) throw failed(`reading task ${task}`, r);
  return parseTaskRun(r.stdout);
}

async function snapshot(run: HostRun): Promise<Snapshot> {
  const r = await run([...PS, SNAPSHOT]);
  if (r.code !== 0) throw failed('the Win32_Process snapshot', r);
  return parseProcesses(r.stdout);
}

async function inspect(run: HostRun): Promise<string> {
  const r = await run(['podman', 'machine', 'inspect']);
  if (r.code !== 0) throw failed('podman machine inspect', r);
  return machineState(r.stdout);
}

const regLine = (rs: Registration[]) =>
  rs.map((r) => `${r.name} ${r.status}${r.busy ? ' busy' : ''}`).join(', ') || 'none';

// ---- legs ----

async function windowsLeg(
  ctx: RunContext,
  c: Check,
  run: HostRun,
  before: WindowsHostState,
  now: WindowsHostState,
  facts: NibfinFacts,
): Promise<{ summary?: string; pre?: string }> {
  const { execution } = ctx.sandbox;
  const regs = () => registrations(ctx.github, execution);

  // Teardown backstop, even when a leg is skipped or the body aborted: only what fits the cleanup timeout.
  ctx.defer(async () => {
    const r = await ctx.exec(['podman', 'machine', 'inspect']);
    let state: string | undefined;
    try {
      state = r.code === 0 ? machineState(r.stdout) : undefined;
    } catch {
      state = undefined;
    }
    if (state !== 'running') await ctx.exec(['podman', 'machine', 'start']);
  });

  // Leg 1: the provisioning runner add, which started the machine (R5.27), has exited.
  await c.part(RULE, async () => {
    const add = facts.commands[0];
    const exited = !!add && add.args.slice(0, 2).join(' ') === 'runner add' && typeof add.code === 'number';
    if (
      !c.that(
        exited,
        RULE,
        `the provisioning runner add has no recorded exit (first command: ${add?.args.join(' ') ?? 'none'})`,
      ) ||
      !add
    )
      return;
    const state = await inspect(run);
    c.that(
      state === 'running',
      RULE,
      `podman machine is ${state} although the runner add that started it exited (code ${add.code})`,
    );
    const rs = await regs();
    c.that(rs.length > 0, RULE, `${execution} lists no runner registration after runner add exited`);
    for (const r of rs)
      c.that(
        r.status === 'online',
        RULE,
        `registration ${r.name} is ${r.status} after the runner add that started the machine exited (code ${add.code})`,
      );
  });

  // Leg 2: stopped, restarted by the R5.13 task, and the task has ended.
  let task: string | undefined;
  await c.part(RULE, async () => {
    const tasks = newTasks(before, now);
    const details = await Promise.all(tasks.map(async (t) => ({ t, d: await readTask(run, t) })));
    task = startTask(details)?.t;
    c.that(!!task, RULE, `no new scheduled task runs podman machine start (new tasks: ${tasks.join(', ') || 'none'})`);
  });
  if (!task) return {};
  const name = task;

  try {
    await waitFor(regs, (rs) => rs.length > 0 && rs.every((r) => r.status === 'online' && !r.busy), {
      what: `every ${execution} registration online and idle`,
      deadlineMs: 10 * 60_000,
      intervalMs: 15_000,
      signal: ctx.signal,
    });
  } catch (error) {
    let seen: string;
    try {
      seen = regLine(await regs());
    } catch (e) {
      seen = `unreadable (${message(e)})`;
    }
    c.fail(
      RULE,
      `a Job keeps a Runner busy or a Runner is offline, so the machine was not stopped: ${seen} (${message(error)})`,
    );
    return {};
  }

  try {
    const runBefore = await readTaskRun(run, name);
    const snap1 = await snapshot(run);

    const stop = await run(['podman', 'machine', 'stop']);
    const stopped = stop.code === 0 ? await inspect(run) : undefined;
    if (stop.code !== 0 || stopped === 'running') {
      return {
        pre: `podman machine stop did not stop the machine (exit ${stop.code}, state ${stopped ?? 'unread'}): ${tail(stop, 300)}`,
      };
    }

    const started = await run([...PS, START_TASK], taskEnv(name));
    if (
      !c.that(
        started.code === 0,
        RULE,
        `Start-ScheduledTask for task ${name} exited ${started.code}: ${tail(started, 300)}`,
      )
    )
      return {};

    let last: TaskRun = runBefore;
    try {
      last = await waitFor(
        async () => (last = await readTaskRun(run, name)),
        (r) => taskEnded(r, runBefore),
        {
          what: `task ${name} to end`,
          deadlineMs: 5 * 60_000,
          intervalMs: 5_000,
          signal: ctx.signal,
        },
      );
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      c.fail(
        RULE,
        `task ${name} still ${last.state} after 300 s (last run ${last.lastRunTime || 'never'}, last result ${hex(last.lastResult)}; ${message(error)})`,
      );
      return {};
    }

    await untilAborted(sleep(SETTLE_MS), ctx.signal);
    const secs = SETTLE_MS / 1000;

    await c.part(RULE, async () => {
      const state = await inspect(run);
      c.that(
        state === 'running',
        RULE,
        `podman machine is ${state} ${secs} s after task ${name} ended (last result ${hex(last.lastResult)})`,
      );
    });
    await c.part(RULE, async () => {
      const rs = await regs();
      c.that(
        rs.length > 0,
        RULE,
        `${execution} lists no runner registration ${secs} s after task ${name} restarted the machine`,
      );
      for (const r of rs)
        c.that(
          r.status === 'online',
          RULE,
          `registration ${r.name} is ${r.status} ${secs} s after task ${name} restarted the machine`,
        );
    });
    await c.part(RULE, async () => {
      const snap2 = await snapshot(run);
      for (const p of strandedConsoles(snap1, snap2)) {
        c.fail(RULE, `${p.name} (pid ${p.pid}, parent pid ${p.ppid}) is still open after task ${name} ended: ${p.why}`);
      }
    });
    return { summary: `task ${name} restarted the machine and ended (last result ${hex(last.lastResult)})` };
  } catch (error) {
    c.fail(RULE, `task ${name}: ${message(error)}`);
    return {};
  } finally {
    await c.part(RULE, async () => {
      try {
        let state: string | undefined;
        try {
          state = await inspect(run);
        } catch {
          state = undefined;
        }
        if (state !== 'running') {
          const r = await run(['podman', 'machine', 'start']);
          if (r.code !== 0) throw failed('podman machine start', r);
        }
        await waitFor(regs, (rs) => rs.length > 0 && rs.every((r) => r.status === 'online'), {
          what: `every ${execution} registration online`,
          deadlineMs: 5 * 60_000,
          intervalMs: 10_000,
          signal: ctx.signal,
        });
      } catch (error) {
        throw new Error(`restore: ${message(error)}`, { cause: error });
      }
    });
  }
}

async function linuxLeg(
  ctx: RunContext,
  c: Check,
  before: HostState & { platform: 'linux' },
  now: HostState & { platform: 'linux' },
): Promise<void> {
  const units = newEnabledUnits(before, now);
  c.that(units.length > 0, RULE, 'runner add enabled no user unit to check');
  const uid = process.getuid?.();
  const runtime = userRuntimeDir();
  const env = runtime === undefined ? {} : { env: { XDG_RUNTIME_DIR: runtime } };
  for (const u of units) {
    await c.part(RULE, async () => {
      if (uid === undefined) throw new Error('the host user has no uid');
      const r = await ctx.exec(['systemctl', '--user', 'show', u, '--property=ActiveState,ControlGroup'], env);
      if (r.code !== 0) throw failed(`systemctl --user show ${u}`, r);
      const problem = unitDetached(parseUnitShow(r.stdout), uid);
      c.that(
        problem === undefined,
        RULE,
        `user unit ${u} ${problem ?? ''}; it must run under user@${uid}.service, not in a login session`,
      );
    });
  }
  c.that(now.linger === 'yes', RULE, `Linger is "${now.linger}"; the user manager would stop with the last session`);
  await c.part(RULE, async () => {
    const r = await ctx.exec(['podman', 'machine', 'list', '--format', 'json']);
    if (r.code !== 0) throw failed('podman machine list', r);
    for (const m of runningMachines(r.stdout))
      c.fail(RULE, `podman machine ${m} is running; the Runners' Podman must not use one on Linux`);
  });
}

export const podmanMachineDetached: Scenario = {
  id: 'podman-machine-detached',
  rules: [RULE],
  platforms: ['linux', 'windows'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const facts = nibfinFacts(ctx);
    const run = hostRun(ctx);
    const now = await readHostState(run, ctx.target.platform);
    const before = facts.hostBefore;
    if (now.platform !== ctx.target.platform || before.platform !== ctx.target.platform) {
      return precondition(
        `host state is ${now.platform} now and ${before.platform} before runner add, target ${ctx.target.platform}`,
      );
    }
    if (now.platform === 'linux' && before.platform === 'linux') {
      await linuxLeg(ctx, c, before, now);
      return c.outcome("the Runners' user units run under the user manager, with linger and no podman machine");
    }
    if (now.platform === 'windows' && before.platform === 'windows') {
      const { summary, pre } = await windowsLeg(ctx, c, run, before, now, facts);
      if (pre && !c.problems.length) return precondition(pre);
      if (pre) c.fail(RULE, `precondition not reached: ${pre}`);
      return c.outcome(`podman machine ran after runner add exited; ${summary ?? 'task restart not checked'}`);
    }
    return precondition(`platform ${ctx.target.platform} is not covered`);
  },
};
