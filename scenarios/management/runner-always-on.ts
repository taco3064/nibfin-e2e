import { untilAborted } from '../../src/abort.ts';
import { readHostState, readRequestsOverride, userRuntimeDir } from '../../src/host/hoststate.ts';
import type { ExecResult } from '../../src/host/exec.ts';
import type { RunContext, Scenario } from '../../src/types.ts';
import { Check, precondition, tail } from '../lib/check.ts';
import { nibfinFacts, registrations } from '../lib/github.ts';
import type { Registration } from '../lib/github.ts';
import { sleep } from '../lib/wait.ts';
import { hostRun, newEnabledUnits } from './runner-add-setup.ts';

/**
 * The idle wait with no command running: 5× WSL's default `vmIdleTimeout` (60 s) and 20× its
 * `instanceIdleTimeout` (15 s), with time for GitHub to see a stopped Runner as offline.
 */
export const ALWAYS_ON_WAIT_MS = 300_000;

export interface Inhibitor {
  what: string[];
  who: string;
  why: string;
  mode: string;
  uid: number;
  pid: number;
}

/** `busctl --json=short call … ListInhibitors` output (`a(ssssuu)`); throws on any other shape. */
export function parseInhibitors(json: string): Inhibitor[] {
  const bad = () => new Error(`ListInhibitors output is not a(ssssuu) JSON: ${json.trim().slice(0, 400) || '(empty)'}`);
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw bad();
  }
  const data = (v as { type?: unknown; data?: unknown } | null)?.data;
  if ((v as { type?: unknown } | null)?.type !== 'a(ssssuu)' || !Array.isArray(data) || !Array.isArray(data[0]))
    throw bad();
  return (data[0] as unknown[]).map((row) => {
    if (!Array.isArray(row) || row.length !== 6) throw bad();
    const [what, who, why, mode, uid, pid] = row as unknown[];
    if (
      typeof what !== 'string' ||
      typeof who !== 'string' ||
      typeof why !== 'string' ||
      typeof mode !== 'string' ||
      typeof uid !== 'number' ||
      typeof pid !== 'number'
    )
      throw bad();
    return { what: what.split(':').filter(Boolean), who, why, mode, uid, pid };
  });
}

/** `systemctl show` `Key=Value` lines as a record. */
export function parseShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** The unified (`0::<path>`) cgroup of a `/proc/<pid>/cgroup` text, or undefined (cgroup v1). */
export function cgroupOf(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) if (line.startsWith('0::')) return line.slice(3).trim();
  return undefined;
}

/** Whether a cgroup path lies under the user manager `user@<uid>.service` and in no login session scope. */
export function inUserManager(path: string | undefined, uid: number | undefined): boolean {
  if (!path || uid === undefined) return false;
  const parts = path.split('/');
  return parts.includes(`user@${uid}.service`) && !parts.some((p) => /^session-.*\.scope$/.test(p));
}

const SECTIONS = new Set(['DISPLAY', 'SYSTEM', 'AWAYMODE', 'EXECUTION', 'PERFBOOST', 'ACTIVELOCKSCREEN']);

export interface PowerRequest {
  section: string;
  entry: string;
  detail: string;
}

/** `powercfg /requests` entries by section; throws when no known section header is present. */
export function parsePowerRequests(stdout: string): PowerRequest[] {
  const out: PowerRequest[] = [];
  let section: string | undefined;
  let headers = 0;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^([A-Z]+):$/.exec(line);
    if (h && SECTIONS.has(h[1] as string)) {
      section = h[1] as string;
      headers++;
      continue;
    }
    if (line === '' || section === undefined || /^none\.?$/i.test(line)) continue;
    const last = out.at(-1);
    if (line.startsWith('[') || !last || last.section !== section) out.push({ section, entry: line, detail: '' });
    else last.detail = last.detail ? `${last.detail} ${line}` : line;
  }
  if (!headers)
    throw new Error(
      `powercfg /requests output has no known section header: ${stdout.trim().slice(0, 400) || '(empty)'}`,
    );
  return out;
}

/** The override lines of `powercfg /requestsoverride`, each prefixed with its caller-type header. */
export function overrideLines(stdout: string): string[] {
  const out: string[] = [];
  let header = '';
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^\[[A-Z]+\]$/.test(line)) header = line;
    else out.push(header ? `${header} ${line}` : line);
  }
  return out;
}

const CALLER = /podman|gvproxy|win-sshproxy|\bwsl|wslservice|wslhost|wslrelay|vmmem|vmcompute|lxssmanager|nibfin/i;

/** Whether a power request entry or its detail names Podman, WSL or Nibfin (not GitHub's hosted agent). */
export const nibfinPowerCaller = (text: string): boolean => CALLER.test(text);

/** Registrations that are listed but not online. */
export const notOnline = (regs: Pick<Registration, 'name' | 'status'>[]) => regs.filter((r) => r.status !== 'online');

/**
 * Problems after the wait: each registration seen before it must still be listed and online;
 * one already offline before is reported again only when its state changed.
 */
export function afterWaitProblems(
  before: Pick<Registration, 'name' | 'status'>[],
  after: Pick<Registration, 'name' | 'status'>[],
  waitS: number,
): string[] {
  const problems: string[] = [];
  for (const b of before) {
    const now = after.find((a) => a.name === b.name)?.status ?? 'no longer listed';
    if (now === 'online' || (b.status !== 'online' && now === b.status)) continue;
    problems.push(
      `registration ${b.name} is ${now} after ${waitS} s idle with no command running (it was ${b.status} before the wait); the Runners must keep running`,
    );
  }
  return problems;
}

const DIGITS = /^\d+$/;

export const runnerAlwaysOn: Scenario = {
  id: 'runner-always-on',
  rules: ['R5.11'],
  platforms: ['linux', 'windows'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const facts = nibfinFacts(ctx);
    const { execution } = ctx.sandbox;
    const run = hostRun(ctx);
    const waitS = ALWAYS_ON_WAIT_MS / 1000;

    // (a) Before the wait: the provisioning runner add has exited and its Runners are online.
    const before = await registrations(ctx.github, execution);
    if (!before.length)
      return precondition(
        `${execution} lists no runner registration, so no Runner exists to keep running (runner-add-setup checks runner add)`,
      );
    for (const r of notOnline(before))
      c.fail(
        'R5.11',
        `registration ${r.name} is ${r.status} before the wait, after the provisioning runner add has exited; expected online`,
      );
    const running = facts.commands.filter((x) => typeof x.code !== 'number');
    c.that(
      !running.length,
      'R5.11',
      `provisioning commands without an exit code: ${running.map((x) => x.args.join(' ')).join(', ')}`,
    );

    // (b) The wait, with no gh nibfin, podman or other host command running.
    ctx.log(`runner-always-on: waiting ${waitS} s with no command running`);
    await untilAborted(sleep(ALWAYS_ON_WAIT_MS), ctx.signal);

    // (c) Every registration seen before is still listed and online.
    await c.part('R5.11', async () => {
      const after = await registrations(ctx.github, execution);
      for (const p of afterWaitProblems(before, after, waitS)) c.fail('R5.11', p);
    });

    let summary = '';
    if (ctx.target.platform === 'linux') summary = await linux(ctx, c, facts.hostBefore);
    if (ctx.target.platform === 'windows') summary = await windows(ctx, c, facts.hostBefore, run);
    return c.outcome(
      `after ${waitS} s idle, ${before.length} registrations on ${execution} still online; ${summary}; no sleep/idle inhibitor or power request`,
    );
  },
};

const show = (r: ExecResult) => tail(r, 300) || `exit ${r.code}, no output`;

async function linux(
  ctx: RunContext,
  c: Check,
  hostBefore: ReturnType<typeof nibfinFacts>['hostBefore'],
): Promise<string> {
  const uid = process.getuid?.();
  const runtime = userRuntimeDir();
  const userEnv = runtime === undefined ? {} : { env: { XDG_RUNTIME_DIR: runtime } };
  let units: string[] = [];

  // (d) Every Runner unit runs under the user manager, not in a login session.
  await c.part('R5.11', async () => {
    if (hostBefore.platform !== 'linux')
      throw new Error(`the host state before runner add is for ${hostBefore.platform}, expected linux`);
    const now = await readHostState(hostRun(ctx), 'linux');
    if (now.platform !== 'linux') throw new Error('the host state is not linux');
    units = newEnabledUnits(hostBefore, now);
    if (!c.that(units.length > 0, 'R5.11', 'no systemd user unit enabled by runner add, so no Runner unit to check'))
      return;
    for (const u of units) {
      await c.part('R5.11', async () => {
        const r = await ctx.exec(
          ['systemctl', '--user', 'show', '-p', 'ActiveState,SubState,ControlGroup,MainPID', u],
          userEnv,
        );
        if (r.code !== 0) return c.fail('R5.11', `systemctl --user show ${u} exited ${r.code}: ${show(r)}`);
        const p = parseShow(r.stdout);
        const values = `ActiveState=${p.ActiveState ?? '?'} SubState=${p.SubState ?? '?'} ControlGroup=${p.ControlGroup ?? '?'} MainPID=${p.MainPID ?? '?'}`;
        c.that(
          p.ActiveState === 'active',
          'R5.11',
          `user unit ${u} is not active after ${ALWAYS_ON_WAIT_MS / 1000} s idle (${values})`,
        );
        c.that(
          inUserManager(p.ControlGroup, uid),
          'R5.11',
          `user unit ${u} does not run under user@${uid ?? '?'}.service outside any login session (${values})`,
        );
        const pid = p.MainPID ?? '0';
        if (DIGITS.test(pid) && pid !== '0') {
          const cg = await ctx.exec(['cat', `/proc/${pid}/cgroup`]);
          const path = cg.code === 0 ? cgroupOf(cg.stdout) : undefined;
          c.that(
            !!path && !!p.ControlGroup && path.startsWith(p.ControlGroup),
            'R5.11',
            `user unit ${u} main process ${pid} is in cgroup ${path ?? `unreadable (${show(cg)})`}, expected under ${p.ControlGroup ?? '?'} (${values})`,
          );
        }
      });
    }
  });

  // Nothing Nibfin set up holds a sleep or idle inhibitor.
  await c.part('R5.11', async () => {
    const r = await ctx.exec([
      'busctl',
      '--json=short',
      'call',
      'org.freedesktop.login1',
      '/org/freedesktop/login1',
      'org.freedesktop.login1.Manager',
      'ListInhibitors',
    ]);
    if (r.code !== 0)
      return c.fail('R5.11', `logind inhibitors cannot be read: busctl ListInhibitors exited ${r.code}: ${show(r)}`);
    let locks: Inhibitor[];
    try {
      locks = parseInhibitors(r.stdout);
    } catch (error) {
      return c.fail(
        'R5.11',
        `logind inhibitors cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const l of locks.filter((x) => x.what.includes('sleep') || x.what.includes('idle'))) {
      const comm = await ctx.exec(['cat', `/proc/${l.pid}/comm`]);
      const cg = await ctx.exec(['cat', `/proc/${l.pid}/cgroup`]);
      if (comm.code !== 0 && cg.code !== 0) continue; // the process has gone, so the lock is released
      const name = comm.code === 0 ? comm.stdout.trim() : '?';
      const ours =
        inUserManager(cg.code === 0 ? cgroupOf(cg.stdout) : undefined, uid) ||
        /podman|conmon|nibfin/i.test(`${name} ${l.who}`);
      c.that(
        !ours,
        'R5.11',
        `inhibitor "${l.what.join(':')}" (mode ${l.mode}) held by ${l.who} (pid ${l.pid}, comm ${name}, why "${l.why}") keeps the host awake`,
      );
    }
  });

  // sleep.target and suspend.target are not masked.
  await c.part('R5.11', async () => {
    const targets = ['sleep.target', 'suspend.target'];
    const r = await ctx.exec(['systemctl', 'show', '-p', 'LoadState', '--value', ...targets]);
    const states = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (r.code !== 0 || states.length !== targets.length)
      return c.fail(
        'R5.11',
        `systemctl show -p LoadState sleep.target suspend.target cannot be read (exit ${r.code}): ${show(r)}`,
      );
    targets.forEach((t, i) => {
      const before =
        hostBefore.platform === 'linux' && hostBefore.systemFiles.includes(t) ? ' (the mask predates runner add)' : '';
      c.that(states[i] !== 'masked', 'R5.11', `${t} is masked${before}, so the host cannot sleep`);
    });
  });
  return `user units ${units.join(', ') || 'none'} active under the user manager`;
}

async function windows(
  ctx: RunContext,
  c: Check,
  hostBefore: ReturnType<typeof nibfinFacts>['hostBefore'],
  run: ReturnType<typeof hostRun>,
): Promise<string> {
  // (e) The machine keeps running on its own: no process that started it remains.
  await c.part('R5.11', async () => {
    const r = await ctx.exec(['podman', 'machine', 'inspect']);
    const state = r.code === 0 ? (JSON.parse(r.stdout) as { State?: string }[])[0]?.State : undefined;
    c.that(
      state === 'running',
      'R5.11',
      `podman machine is ${state ?? `not readable (${show(r)})`} after ${ALWAYS_ON_WAIT_MS / 1000} s idle, expected running`,
    );
  });
  await c.part('R5.11', async () => {
    const script =
      'ConvertTo-Json -Compress @(Get-Process -Name gh-nibfin -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })';
    const r = await ctx.exec(['powershell', '-NoProfile', '-NonInteractive', '-Command', script]);
    if (r.code !== 0) return c.fail('R5.11', `the gh-nibfin processes cannot be listed: ${show(r)}`);
    const v: unknown = JSON.parse(r.stdout.trim() || '[]');
    const pids = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'number');
    c.that(
      !pids.length,
      'R5.11',
      `gh-nibfin processes ${pids.join(', ')} are still running; podman machine must not depend on the process that started it`,
    );
  });

  // No power request from Podman, WSL or Nibfin keeps the host awake.
  await c.part('R5.11', async () => {
    const r = await ctx.exec(['powercfg', '/requests']);
    if (r.code !== 0) return c.fail('R5.11', `powercfg /requests cannot be read (exit ${r.code}): ${show(r)}`);
    let requests: PowerRequest[];
    try {
      requests = parsePowerRequests(r.stdout);
    } catch (error) {
      return c.fail('R5.11', error instanceof Error ? error.message : String(error));
    }
    for (const q of requests.filter(
      (x) => ['SYSTEM', 'AWAYMODE', 'EXECUTION'].includes(x.section) && nibfinPowerCaller(`${x.entry} ${x.detail}`),
    )) {
      c.fail('R5.11', `power request ${q.section}: ${q.entry}${q.detail ? ` (${q.detail})` : ''} keeps the host awake`);
    }
  });
  await c.part('R5.11', async () => {
    if (hostBefore.platform !== 'windows')
      throw new Error(`the host state before runner add is for ${hostBefore.platform}, expected windows`);
    const was = hostBefore.requestsOverride;
    if (!was.ok)
      return c.fail(
        'R5.11',
        `the power request overrides before runner add could not be read: ${was.output.slice(-300)}`,
      );
    const now = await readRequestsOverride(run);
    if (!now.ok) return c.fail('R5.11', `the power request overrides cannot be read now: ${now.output.slice(-300)}`);
    const had = new Set(overrideLines(was.output));
    for (const l of overrideLines(now.output).filter((x) => !had.has(x)))
      c.fail('R5.11', `power request override gained since before runner add: ${l}`);
  });
  return 'podman machine running with no gh-nibfin process';
}
