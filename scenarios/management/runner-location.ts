import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { readHostState, userRuntimeDir } from '../../src/host/hoststate.ts';
import type { HostState } from '../../src/host/hoststate.ts';
import type { Scenario } from '../../src/types.ts';
import { Check, tail } from '../lib/check.ts';
import { registrations } from '../lib/github.ts';
import type { Registration } from '../lib/github.ts';
import type { KitFor } from '../lib/kit.ts';
import { runnerSlot } from '../lib/runners.ts';
import { readMachine, shQuote, tryExec, vmExec } from '../lib/vm.ts';
import { cgroupPids, descendants, hostFs, listenerRoot, matchRunners, parseRunnerFile, processRoot } from './host-requirements.ts';
import type { HostFs, LocalRunner, RunnerFile } from './host-requirements.ts';
import { newEnabledUnits } from './runner-add-setup.ts';

const RULE = 'R5.10';

/** True when GitHub's runner `os` names Linux, in any case. */
export const isLinuxOs = (os: unknown): boolean => typeof os === 'string' && os.toLowerCase() === 'linux';

/** `systemctl show` output: one `Key=Value` block per unit, blocks separated by blank lines; CR characters are dropped. */
export function parseShow(stdout: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> | undefined;
  for (const raw of stdout.replace(/\r/g, '').split('\n')) {
    if (raw.trim() === '') {
      cur = undefined;
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    if (!cur) out.push((cur = {}));
    cur[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

/**
 * The user manager and unit of a cgroup v2 path or `/proc/<pid>/cgroup` line:
 * `[0::]/user.slice/user-<uid>.slice/user@<uid>.service/…/<unit>.service[/…]` gives
 * `{uid, unit}`, the first `.service` below the user manager. Anything else (a system
 * service, `machine.slice`, a libpod scope, a cgroup v1 line) gives undefined.
 */
export function unitOfCgroup(line: string): { uid: number; unit: string } | undefined {
  const t = line.trim();
  const path = t.startsWith('0::') ? t.slice(3) : t.startsWith('/') ? t : undefined;
  if (path === undefined) return undefined;
  const m = /^\/user\.slice\/user-(\d+)\.slice\/user@(\d+)\.service\/(.+)$/.exec(path);
  if (!m || m[1] !== m[2]) return undefined;
  const unit = (m[3] as string).split('/').find((s) => s.endsWith('.service'));
  return unit ? { uid: Number(m[1]), unit } : undefined;
}

const MARK = 'nibfin-e2e';

/**
 * Prints the VM user's uid, home and data directory, then for every process whose executable
 * (or `argv[0]`) is `<root>/bin/Runner.Listener`: its path, each `/proc/<pid>/cgroup` line and
 * `<root>/.runner` as base64 (`-` when it cannot be read). Fixed text; nothing is interpolated.
 */
export const DISCOVER = [
  `echo "${MARK} uid $(id -u)"`,
  `echo "${MARK} home $HOME"`,
  `echo "${MARK} data \${XDG_DATA_HOME:-$HOME/.local/share}"`,
  'for d in /proc/[0-9]*; do p=${d#/proc/}; a=$(readlink "$d/exe" 2>/dev/null)',
  `case "$a" in */bin/Runner.Listener) ;; *) a=$(tr '\\0' '\\n' < "$d/cmdline" 2>/dev/null | head -n 1);; esac`,
  'case "$a" in */bin/Runner.Listener) ;; *) continue;; esac',
  `echo "${MARK} listener $p $a"`,
  `while IFS= read -r l; do echo "${MARK} cgroup $p $l"; done < "$d/cgroup"`,
  'r=${a%/bin/Runner.Listener}',
  `if [ -r "$r/.runner" ]; then echo "${MARK} runner $p $(base64 < "$r/.runner" | tr -d '\\n')"; else echo "${MARK} runner $p -"; fi`,
  'done',
].join('; ');

export interface VmListener {
  pid: number;
  path: string;
  cgroups: string[];
  /** `<root>/.runner`'s text, undefined when the VM could not read it. */
  runner?: string;
}

export interface VmReport {
  uid?: number;
  home?: string;
  data?: string;
  listeners: VmListener[];
}

/** Reads {@link DISCOVER}'s output; only lines with its prefix count, so an ssh banner or other text is ignored. */
export function parseVmReport(stdout: string): VmReport {
  const report: VmReport = { listeners: [] };
  const byPid = new Map<number, VmListener>();
  for (const raw of stdout.replace(/\r/g, '').split('\n')) {
    const m = new RegExp(`^${MARK} (uid|home|data|listener|cgroup|runner) (.*)$`).exec(raw);
    if (!m) continue;
    const [, kind, rest] = m as unknown as [string, string, string];
    if (kind === 'uid') {
      if (/^\d+$/.test(rest.trim())) report.uid = Number(rest.trim());
      continue;
    }
    if (kind === 'home' || kind === 'data') {
      if (rest.startsWith('/')) report[kind] = rest;
      continue;
    }
    const p = /^(\d+) (.*)$/.exec(rest);
    if (!p) continue;
    const pid = Number(p[1]);
    const value = p[2] as string;
    if (kind === 'listener') {
      const l: VmListener = { pid, path: value, cgroups: [] };
      byPid.set(pid, l);
      report.listeners.push(l);
      continue;
    }
    const l = byPid.get(pid);
    if (!l) continue;
    if (kind === 'cgroup') l.cgroups.push(value);
    else if (value !== '-' && /^[A-Za-z0-9+/=]+$/.test(value)) l.runner = Buffer.from(value, 'base64').toString('utf8');
  }
  return report;
}

export interface WinProcess {
  ProcessId: number;
  ParentProcessId: number;
  Name: string | null;
  ExecutablePath: string | null;
}

export interface WinService {
  Name: string | null;
  State: string | null;
  PathName: string | null;
}

/** PowerShell `ConvertTo-Json` output: empty (no objects), a single object, or an array. Throws when it is not JSON. */
export function parseWinList<T>(stdout: string): T[] {
  const text = stdout.replace(/^\uFEFF/, '').trim();
  if (text === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`not JSON: ${text.slice(0, 200)}`);
  }
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x): x is T => typeof x === 'object' && x !== null);
}

const RUNNER_PROCESSES = new Set(['runner.listener.exe', 'runner.worker.exe']);
const isRunnerProcess = (p: WinProcess) => RUNNER_PROCESSES.has((p.Name ?? '').toLowerCase());

export interface Hosting {
  /** The nearest `Runner.Worker.exe` or `Runner.Listener.exe` ancestor of this process, if any. */
  process?: WinProcess;
  /** Its install root (`<root>\bin\Runner.Worker.exe`); undefined when its path is empty. */
  root?: string;
}

/**
 * The runner hosting this job: from `selfPid`, follows `ParentProcessId` to the first
 * `Runner.Worker.exe` or `Runner.Listener.exe` (any case). Stops at a missing parent, a
 * repeated PID or 64 steps; then there is none.
 */
export function hostingRunner(processes: WinProcess[], selfPid: number): Hosting {
  const byPid = new Map(processes.map((p) => [p.ProcessId, p]));
  const seen = new Set<number>();
  let cur = byPid.get(selfPid);
  for (let i = 0; cur && i < 64 && !seen.has(cur.ProcessId); i++) {
    seen.add(cur.ProcessId);
    const parent = byPid.get(cur.ParentProcessId);
    if (!parent || seen.has(parent.ProcessId)) break;
    if (isRunnerProcess(parent)) return { process: parent, root: parent.ExecutablePath ? win32.dirname(win32.dirname(parent.ExecutablePath)) : undefined };
    cur = parent;
  }
  return {};
}

/** True when the Windows path lies under `root` (case-insensitive). */
export function underWin(path: string, root: string): boolean {
  const p = win32.normalize(path).toLowerCase();
  const r = win32.normalize(root).toLowerCase().replace(/\\+$/, '');
  return p.startsWith(`${r}\\`);
}

/** The program of a service `PathName`: the quoted part, else up to `.exe`, else the whole text. */
export function serviceProgram(pathName: string): string {
  const t = pathName.trim();
  const quoted = /^"([^"]*)"/.exec(t);
  if (quoted) return quoted[1] as string;
  return /^(.*?\.exe)(\s|$)/i.exec(t)?.[1] ?? t;
}

/**
 * Proposal R5.10 on the Windows host: no Runner process (`Runner.Listener.exe`,
 * `Runner.Worker.exe`) and no `actions.runner.*` service outside `hostingRoot`, the install
 * root of the runner hosting this job. A process or service whose path is empty is a problem
 * too. With no hosting root, every one is.
 */
export function winRunnerProblems(processes: WinProcess[], services: WinService[], hostingRoot: string | undefined): string[] {
  const out: string[] = [];
  const inside = (path: string) => hostingRoot !== undefined && underWin(path, hostingRoot);
  const where = hostingRoot === undefined ? 'with no runner hosting this job found' : `outside ${hostingRoot}, the runner hosting this job`;
  for (const p of processes.filter(isRunnerProcess)) {
    if (!p.ExecutablePath) out.push(`Windows host process ${p.Name} PID ${p.ProcessId} has no ExecutablePath; cannot tell whether it is the runner hosting this job`);
    else if (!inside(p.ExecutablePath)) out.push(`Windows host runs ${p.Name} PID ${p.ProcessId} from ${p.ExecutablePath} ${where}; Runners must run inside the podman machine VM`);
  }
  for (const s of services.filter((x) => (x.Name ?? '').toLowerCase().startsWith('actions.runner.'))) {
    if (!s.PathName?.trim()) out.push(`Windows service ${s.Name} (${s.State ?? 'unknown state'}) has no PathName; cannot tell whether it is the runner hosting this job`);
    else if (!inside(serviceProgram(s.PathName))) out.push(`Windows service ${s.Name} (${s.State ?? 'unknown state'}) runs ${s.PathName} ${where}; Runners must run inside the podman machine VM`);
  }
  return out;
}

export interface Layout {
  /** The registration's slot (`claude-<n>`), undefined when its name has none. */
  slot: string | undefined;
  registration: string;
  unit: string;
  root: string;
  fragment: string | undefined;
  home: string;
  dataDir: string;
}

/**
 * The shared Linux install path: the unit is `nibfin-runner-<slot>.service`, the root is
 * `<data>/nibfin/runners/<slot>`, and the unit file lies under the user's home (a
 * user-installed unit, not one in /etc or /usr). POSIX paths, so the VM's read the same.
 */
export function layoutProblems(l: Layout): string[] {
  if (!l.slot) return [`registration ${l.registration} has no -claude-<n> slot in its name`];
  const out: string[] = [];
  const unit = `nibfin-runner-${l.slot}.service`;
  if (l.unit !== unit) out.push(`registration ${l.registration} runs in unit ${l.unit}, expected ${unit}`);
  const root = posix.join(l.dataDir, 'nibfin', 'runners', l.slot);
  if (posix.normalize(l.root) !== root) out.push(`registration ${l.registration} runs from ${l.root}, expected ${root}`);
  const home = posix.normalize(l.home).replace(/\/+$/, '');
  const fragment = l.fragment ? posix.normalize(l.fragment) : '';
  if (!fragment.startsWith(`${home}/`)) out.push(`unit ${l.unit} of ${l.registration} is loaded from ${l.fragment || '(no FragmentPath)'}, expected a user unit file under ${home}`);
  return out;
}

/** The unit names a VM command may carry. */
const UNIT_NAME = /^[A-Za-z0-9@._-]+\.service$/;

const PROCESSES = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';
const SERVICES = "Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'actions.runner.*' } | Select-Object Name,State,PathName | ConvertTo-Json -Compress";

const list = (xs: string[], none = 'none') => (xs.length ? xs.join(', ') : none);

export interface LocationDeps {
  fs?: HostFs;
  /** This e2e process (`process.pid`). */
  pid?: number;
  /** The host user's uid (`process.getuid()`). */
  uid?: number;
}

interface Placed extends LocalRunner {
  unit: string;
  fragment: string | undefined;
}

/** Each registration's runner, the matching problems, and the layout problems. */
function judge(c: Check, where: string, placed: Placed[], regs: Registration[], home: string, dataDir: string): Placed[] {
  const m = matchRunners(placed, regs);
  c.that(m.unregistered.length === 0, RULE, `${where}: runner roots without a registration on the execution sandbox: ${list(m.unregistered)}`);
  c.that(m.unbacked.length === 0, RULE, `${where}: registrations backed by no runner: ${list(m.unbacked)}`);
  c.that(m.duplicated.length === 0, RULE, `${where}: registrations backed by several runners: ${list(m.duplicated)}`);
  const matched: Placed[] = [];
  for (const g of regs) {
    const p = placed.find((x) => x.file?.agentId === g.id && x.file?.agentName === g.name);
    if (!p) continue;
    matched.push(p);
    for (const problem of layoutProblems({ slot: runnerSlot(g.name), registration: g.name, unit: p.unit, root: p.root, fragment: p.fragment, home, dataDir })) c.fail(RULE, `${where}: ${problem}`);
  }
  return matched;
}

const layoutSummary = (where: string, matched: Placed[], dataDir: string, home: string) =>
  `Runners ${list(matched.map((p) => p.unit))} run as systemd user services ${where}; compared unit name nibfin-runner-<slot>.service, root ${dataDir}/nibfin/runners/<slot> and unit file under ${home} with the Linux layout`;

/**
 * Proposal R5.10: on Linux the Runners run directly on the host; on Windows inside the
 * `podman machine` Linux VM as systemd user services and not on the Windows host; both with
 * the same Linux install path. Reads the host, the VM (`podman machine ssh`) and GitHub's
 * runner API; writes nothing.
 */
export function runnerLocation(kitFor: KitFor, deps: LocationDeps = {}): Scenario {
  return {
    id: 'runner-location',
    rules: [RULE],
    platforms: ['linux', 'windows'],
    requires: ['nibfin'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const c = new Check();
      const fs = deps.fs ?? hostFs;
      const platform = ctx.target.platform;
      const execution = kit.sandbox.execution;
      const before = (kit.facts('nibfin') ?? {}).hostBefore as HostState | undefined;
      if (before?.platform !== platform) {
        c.fail(RULE, `the nibfin step recorded no ${platform} host state before runner add (found ${before?.platform ?? 'none'})`);
        return c.outcome('');
      }
      const summary: string[] = [];

      // Both platforms: GitHub sees Linux runners.
      let regs: Registration[] = [];
      await c.part(RULE, async () => {
        regs = await registrations(kit.github, execution);
        c.that(regs.length > 0, RULE, `${execution} lists no runner registration`);
        for (const r of regs) c.that(isLinuxOs(r.os), RULE, `registration ${r.name} reports os ${r.os ?? '(none)'} in GitHub's runner API, expected Linux`);
        summary.push(`${regs.length} registrations on ${execution} report os Linux`);
      });

      if (before.platform === 'linux') {
        const uid = deps.uid ?? process.getuid?.();
        const home = kit.env.HOME?.trim() || homedir();
        const dataDir = kit.env.XDG_DATA_HOME?.trim() || posix.join(home, '.local', 'share');
        await c.part(RULE, async () => {
          const now = await readHostState((argv, env) => kit.exec(argv, { env }), 'linux', { env: kit.env, ...(uid === undefined ? {} : { uid }) });
          if (now.platform !== 'linux') throw new Error('the host state read is not Linux');
          const units = newEnabledUnits(before, now);
          if (!c.that(units.length > 0, RULE, 'runner add enabled no new systemd user unit on the host')) return;
          const runtime = userRuntimeDir(kit.env, uid);
          const env = runtime === undefined ? undefined : { XDG_RUNTIME_DIR: runtime };
          const self = { pid: fs.readlink('/proc/self/ns/pid'), mnt: fs.readlink('/proc/self/ns/mnt') };
          const placed: Placed[] = [];
          for (const u of units) {
            const argv = ['systemctl', '--user', 'show', '-p', 'Id', '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'ControlGroup', '-p', 'MainPID', '-p', 'FragmentPath', u];
            const r = await tryExec(kit.exec, argv, env ? { env } : undefined);
            if (r.code !== 0) {
              c.fail(RULE, `systemctl --user show ${u} exited ${r.code}: ${tail(r)}`);
              continue;
            }
            const p = parseShow(r.stdout)[0] ?? {};
            c.that(p.ActiveState === 'active' && p.UnitFileState === 'enabled', RULE, `host user unit ${u} is ActiveState=${p.ActiveState ?? '(none)'} UnitFileState=${p.UnitFileState ?? '(none)'}, expected active and enabled`);
            const cg = p.ControlGroup ?? '';
            const owner = unitOfCgroup(cg);
            c.that(uid !== undefined && owner?.uid === uid && owner.unit === u, RULE, `host user unit ${u} runs in cgroup ${cg || '(none)'}, expected ${u} under /user.slice/user-${uid ?? '?'}.slice/user@${uid ?? '?'}.service/ (the host user's own manager)`);
            let pids = cg ? cgroupPids(fs, cg) : [];
            let source = `cgroup ${cg || '(none)'}`;
            if (!pids.length) {
              const main = Number(p.MainPID);
              pids = main > 0 ? descendants(fs, main) : [];
              source = `MainPID ${main || 'none'} and its descendants`;
            }
            const listeners = pids.map((pid) => ({ pid, root: processRoot(fs, pid) })).filter((x): x is { pid: number; root: string } => x.root !== undefined);
            if (!c.that(listeners.length > 0, RULE, `host user unit ${u} runs no official runner <root>/bin/Runner.Listener (${source}: ${pids.length} processes)`)) continue;
            for (const l of listeners) {
              for (const ns of ['pid', 'mnt'] as const) {
                const link = fs.readlink(`/proc/${l.pid}/ns/${ns}`);
                c.that(link !== undefined && self[ns] !== undefined && link === self[ns], RULE, `Runner.Listener PID ${l.pid} of ${u} is in ${ns} namespace ${link ?? '(unreadable)'}, the host's is ${self[ns] ?? '(unreadable)'}; expected a host process, not one in a container`);
              }
              if (!placed.some((x) => x.root === l.root)) placed.push({ root: l.root, unit: u, fragment: p.FragmentPath });
            }
          }
          for (const r of placed) {
            const text = fs.readFile(join(r.root, '.runner'));
            r.file = text === undefined ? undefined : parseRunnerFile(text);
            c.that(!!r.file, RULE, `${r.root}/.runner on the host is ${text === undefined ? 'not readable' : 'not a JSON object'}`);
          }
          if (!c.that(placed.length > 0, RULE, 'no Runner.Listener runs in any user unit runner add enabled on the host')) return;
          const matched = judge(c, 'Linux host', placed, regs, home, dataDir);
          summary.push(layoutSummary(`directly on the host under user@${uid}.service, in the host's PID and mount namespaces`, matched, dataDir, home));
        });
      }

      if (before.platform === 'windows') {
        const pid = deps.pid ?? process.pid;
        const ps = async (script: string, what: string) => {
          const r = await tryExec(kit.exec, ['powershell', '-NoProfile', '-NonInteractive', '-Command', script]);
          if (r.code !== 0) throw new Error(`powershell ${what} exited ${r.code}: ${tail(r)}`);
          try {
            return parseWinList(r.stdout);
          } catch (error) {
            throw new Error(`powershell ${what} printed ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        };

        // The Windows host runs no Runner except the one hosting this job.
        await c.part(RULE, async () => {
          const processes = (await ps(PROCESSES, 'Get-CimInstance Win32_Process')) as WinProcess[];
          const services = (await ps(SERVICES, 'Get-CimInstance Win32_Service')) as WinService[];
          const hosting = hostingRunner(processes, pid);
          if (hosting.process && hosting.root === undefined) c.fail(RULE, `the runner hosting this job, ${hosting.process.Name} PID ${hosting.process.ProcessId}, has no ExecutablePath; its install root cannot be read`);
          for (const problem of winRunnerProblems(processes, services, hosting.root)) c.fail(RULE, problem);
          summary.push(hosting.process && hosting.root !== undefined ? `no other Runner process or actions.runner.* service on the Windows host; excluded the runner hosting this job: ${hosting.process.Name} PID ${hosting.process.ProcessId} under ${hosting.root}` : 'no Runner process or actions.runner.* service on the Windows host; no hosting runner found');
        });

        // Inside the podman machine VM.
        await c.part(RULE, async () => {
          const machine = await readMachine(kit.exec);
          if (!c.that(machine.state === 'running', RULE, `podman machine ${machine.name} is ${machine.state || '(no State)'}, expected running`)) return;
          const out = await vmExec(kit.exec, machine.name, DISCOVER);
          const report = parseVmReport(out);
          if (report.uid === undefined || report.home === undefined || report.data === undefined) {
            throw new Error(`podman machine ssh ${machine.name} printed no uid, home or data line: ${tail({ stdout: out, stderr: '' }, 300)}`);
          }
          if (!c.that(report.listeners.length > 0, RULE, `no Runner.Listener runs inside podman machine ${machine.name}`)) return;
          const placed: Placed[] = [];
          for (const l of report.listeners) {
            const root = listenerRoot(l.path);
            const owner = l.cgroups.map(unitOfCgroup).find((x) => x !== undefined);
            if (!c.that(root !== undefined, RULE, `VM Runner.Listener PID ${l.pid} runs from ${l.path}, not an absolute <root>/bin/Runner.Listener`) || root === undefined) continue;
            if (!c.that(owner !== undefined && owner.uid === report.uid, RULE, `VM Runner.Listener PID ${l.pid} (${root}) is in cgroup ${list(l.cgroups, '(none)')}, expected a .service unit under user@${report.uid}.service of the ssh user`) || !owner) continue;
            if (placed.some((x) => x.root === root)) continue;
            let file: RunnerFile | undefined;
            if (l.runner === undefined) c.fail(RULE, `${root}/.runner inside podman machine ${machine.name} is not readable`);
            else if (!(file = parseRunnerFile(l.runner))) c.fail(RULE, `${root}/.runner inside podman machine ${machine.name} is not a JSON object`);
            placed.push({ root, unit: owner.unit, fragment: undefined, ...(file ? { file } : {}) });
          }
          const units = [...new Set(placed.map((p) => p.unit))];
          const bad = units.filter((u) => !UNIT_NAME.test(u));
          c.that(bad.length === 0, RULE, `VM unit names outside ${UNIT_NAME.source}: ${list(bad)}`);
          const good = units.filter((u) => UNIT_NAME.test(u));
          if (good.length) {
            const script = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; systemctl --user show -p Id -p ActiveState -p UnitFileState -p FragmentPath ${good.map(shQuote).join(' ')}`;
            const shown = parseShow(await vmExec(kit.exec, machine.name, script));
            for (const u of good) {
              const s = shown.find((x) => x.Id === u);
              if (!c.that(!!s, RULE, `systemctl --user show inside podman machine ${machine.name} printed nothing for ${u}`) || !s) continue;
              c.that(s.ActiveState === 'active' && s.UnitFileState === 'enabled', RULE, `VM user unit ${u} is ActiveState=${s.ActiveState ?? '(none)'} UnitFileState=${s.UnitFileState ?? '(none)'}, expected active and enabled`);
              for (const p of placed) if (p.unit === u) p.fragment = s.FragmentPath;
            }
          }
          const matched = judge(c, `podman machine ${machine.name}`, placed, regs, report.home, report.data);
          summary.push(layoutSummary(`inside podman machine ${machine.name} under user@${report.uid}.service of the ssh user`, matched, report.data, report.home));
        });
      }

      return c.outcome(summary.join('; '));
    },
  };
}
