import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { ExecResult } from './exec.ts';
import type { Platform } from '../types.ts';

/** Runs one host command; no token ever goes to these children. */
export type HostRun = (argv: string[], env?: Record<string, string>) => Promise<ExecResult>;

export interface LinuxHostState {
  platform: 'linux';
  /** `systemctl --user list-unit-files`: unit name and its state (enabled, disabled, static, …). */
  units: { name: string; state: string }[];
  /** `loginctl show-user <user> -p Linger --value`. */
  linger: string;
  /** Every file under /etc/systemd/system, relative to it. */
  systemFiles: string[];
  /** Host epoch ms when the state was read; an entry whose ctime is later changed after it (Proposal R5.9). */
  readAt: number;
  /** The deduplicated directories of the `PATH` the read was given (Proposal R5.9). */
  pathDirs: string[];
  /** The periodic mechanisms before `runner add` (Proposal R5.17); set only by provisioning. */
  periodic?: Baseline<Periodic>;
}

export interface WindowsHostState {
  platform: 'windows';
  /** `%UserProfile%\.wslconfig`, or null when there is none. */
  wslconfig: string | null;
  /** Every scheduled task as `<TaskPath><TaskName>`. */
  tasks: string[];
  /** The periodic mechanisms inside the podman machine VM before `runner add` (Proposal R5.17); set only by provisioning. */
  vm?: Baseline<Periodic>;
}

export type HostState = LinuxHostState | WindowsHostState;

const fail = (argv: string[], r: ExecResult) => new Error(`${argv.slice(0, 3).join(' ')} exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).slice(-2000)}`);

async function must(run: HostRun, argv: string[], env?: Record<string, string>): Promise<string> {
  const r = await run(argv, env);
  if (r.code !== 0) throw fail(argv, r);
  return r.stdout;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

export function parseUnitFiles(stdout: string): { name: string; state: string }[] {
  return stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0] !== '' && !/unit files listed/i.test(p.join(' ')))
    .map(([name, state]) => ({ name: name as string, state: state as string }));
}

export function wslconfigPath(): string {
  return join(process.env.USERPROFILE ?? homedir(), '.wslconfig');
}

/** A minimal INI read: `{section: {key: value}}`, keys and sections lowercased. */
export function parseIni(text: string | null): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = (s[1] as string).trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    (out[section] ??= {})[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

const TASKS = 'ConvertTo-Json -Compress @(Get-ScheduledTask | ForEach-Object { $_.TaskPath + $_.TaskName })';

export function parseJsonList(stdout: string): string[] {
  const v: unknown = JSON.parse(stdout.trim() || '[]');
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x): x is string => typeof x === 'string').sort();
}

/**
 * The user manager's runtime directory: `XDG_RUNTIME_DIR`, or `/run/user/<uid>` when the
 * shell does not set it (a hosted job's shell may not). `systemctl --user` needs it.
 */
export function userRuntimeDir(env: Record<string, string | undefined> = process.env, uid: number | undefined = process.getuid?.()): string | undefined {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  return uid === undefined ? undefined : `/run/user/${uid}`;
}

/** Whether the user manager runs: the runtime directory has its `systemd/private` or `bus` socket. */
export function hasUserManager(runtime: string | undefined, exists: (path: string) => boolean = existsSync): boolean {
  return runtime !== undefined && (exists(join(runtime, 'systemd', 'private')) || exists(join(runtime, 'bus')));
}

export interface LinuxReadOptions {
  env?: Record<string, string | undefined>;
  uid?: number;
  user?: string;
  /** Whether a path exists; injectable for tests. */
  exists?: (path: string) => boolean;
  /** `/etc/systemd/system`'s file list; injectable for tests. */
  systemFiles?: () => string[];
  /** The units the user's own config enables (see {@link userEnabledUnits}); injectable for tests. */
  userEnabled?: () => string[];
  /** The host clock in epoch ms; injectable for tests. */
  now?: () => number;
}

/** The deduplicated, non-empty directories of a `PATH` value, in order. */
export function pathDirectories(path: string | undefined): string[] {
  return [...new Set((path ?? '').split(':').filter((d) => d !== ''))];
}

/**
 * The units the user's own unit directory enables without a running manager: every entry of
 * `${XDG_CONFIG_HOME:-~/.config}/systemd/user/<unit>.wants|.requires/`, which is what
 * `systemctl --user enable` creates there.
 */
export function userEnabledUnits(env: Record<string, string | undefined> = process.env, home: string = homedir()): string[] {
  const dir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user');
  if (!existsSync(dir)) return [];
  const names = new Set<string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !/\.(wants|requires)$/.test(e.name)) continue;
    for (const u of readdirSync(join(dir, e.name))) names.add(u);
  }
  return [...names].sort();
}

/**
 * The user units enabled without a running manager: the globally enabled ones
 * (`systemctl --global list-unit-files`, which reads unit files only) with the user's own
 * enabled units set to `enabled` over them.
 */
async function offlineUserUnits(run: HostRun, userEnabled: string[]): Promise<{ name: string; state: string }[]> {
  const argv = ['systemctl', '--global', 'list-unit-files', '--no-legend', '--plain'];
  const listed = await run(argv);
  if (listed.code !== 0) throw fail(argv, listed);
  const units = new Map(parseUnitFiles(listed.stdout).map((u) => [u.name, u.state]));
  for (const name of userEnabled) units.set(name, 'enabled');
  return [...units].map(([name, state]) => ({ name, state }));
}

/**
 * Linux host state. Before `runner add` the user manager may not run and the user may be
 * neither logged in nor lingering, so `systemctl --user` or `loginctl show-user` can fail.
 * Then, when the runtime directory has no manager socket, the user units are read from the
 * unit files alone (the globally enabled ones and the user's own `.wants` entries), so that
 * units the image already enables are not taken for new ones; linger reads `no` when
 * /var/lib/systemd/linger has no file for the user. Any other failure still throws.
 */
export async function readLinuxHostState(run: HostRun, options: LinuxReadOptions = {}): Promise<LinuxHostState> {
  const readAt = (options.now ?? Date.now)();
  const exists = options.exists ?? existsSync;
  const runtime = userRuntimeDir(options.env ?? process.env, options.uid);
  const env = runtime === undefined ? undefined : { XDG_RUNTIME_DIR: runtime };
  const user = options.user ?? userInfo().username;

  const unitsArgv = ['systemctl', '--user', 'list-unit-files', '--no-legend', '--plain'];
  const listed = await run(unitsArgv, env);
  let units: { name: string; state: string }[];
  if (listed.code === 0) units = parseUnitFiles(listed.stdout);
  else if (!hasUserManager(runtime, exists)) units = await offlineUserUnits(run, (options.userEnabled ?? (() => userEnabledUnits(options.env ?? process.env)))());
  else throw fail(unitsArgv, listed);

  const lingerArgv = ['loginctl', 'show-user', user, '-p', 'Linger', '--value'];
  const shown = await run(lingerArgv, env);
  let linger: string;
  if (shown.code === 0) linger = shown.stdout.trim();
  else if (!exists(join('/var/lib/systemd/linger', user))) linger = 'no';
  else throw fail(lingerArgv, shown);

  const systemFiles = (options.systemFiles ?? (() => listFiles('/etc/systemd/system')))();
  return { platform: 'linux', units, linger, systemFiles, readAt, pathDirs: pathDirectories((options.env ?? process.env).PATH) };
}

/** The host state the always-on setup changes (Proposal R5.13, R5.15, R5.16, R5.28), read without any product name. */
export async function readHostState(run: HostRun, platform: Platform, linux: LinuxReadOptions = {}): Promise<HostState> {
  if (platform === 'linux') return readLinuxHostState(run, linux);
  if (platform === 'windows') {
    const path = wslconfigPath();
    const wslconfig = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const tasks = parseJsonList(await must(run, ['powershell', '-NoProfile', '-NonInteractive', '-Command', TASKS]));
    return { platform, wslconfig, tasks };
  }
  throw new Error('macOS host state is not supported (Phase 5)');
}

/**
 * Windows: when `.wslconfig` has no `[wsl2]` section, writes one with the documented
 * default `nestedVirtualization=true`, which changes nothing, so that "other settings are
 * kept" (Proposal R5.13) can be observed.
 */
export function seedWslconfig(): void {
  const path = wslconfigPath();
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if ('wsl2' in parseIni(text)) return;
  const sepLine = text === '' || text.endsWith('\n') ? '' : '\r\n';
  writeFileSync(path, `${text}${sepLine}[wsl2]\r\nnestedVirtualization=true\r\n`);
}

export interface TaskDetail {
  actions: { execute: string; arguments: string }[];
  /** CIM class names, for example `MSFT_TaskLogonTrigger`. */
  triggers: string[];
  /** Each trigger's `Repetition.Interval` in trigger order (`''` when unset); `[]` when the read gave none. */
  repetitions: string[];
}

const TASK =
  '$t = Get-ScheduledTask -TaskPath $env:NIBFIN_E2E_TASK_PATH -TaskName $env:NIBFIN_E2E_TASK_NAME; ' +
  '@{ actions = @($t.Actions | ForEach-Object { @{ execute = [string]$_.Execute; arguments = [string]$_.Arguments } }); ' +
  'triggers = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }); ' +
  'repetitions = @($t.Triggers | ForEach-Object { [string]$_.Repetition.Interval }) } | ConvertTo-Json -Compress -Depth 4';

/** One scheduled task's actions and trigger kinds; the name reaches PowerShell only through the environment. */
export async function readTask(run: HostRun, fullName: string): Promise<TaskDetail> {
  const cut = fullName.lastIndexOf('\\') + 1;
  const env = { NIBFIN_E2E_TASK_PATH: fullName.slice(0, cut), NIBFIN_E2E_TASK_NAME: fullName.slice(cut) };
  return parseTask(JSON.parse(await must(run, ['powershell', '-NoProfile', '-NonInteractive', '-Command', TASK], env)) as Record<string, unknown>);
}

/** A task read's JSON: missing lists are empty, and a null repetition is unset (`''`). */
export function parseTask(v: Record<string, unknown>): TaskDetail {
  return {
    actions: Array.isArray(v.actions) ? (v.actions as TaskDetail['actions']) : [],
    triggers: Array.isArray(v.triggers) ? (v.triggers as string[]) : [],
    repetitions: Array.isArray(v.repetitions) ? v.repetitions.map((x) => (typeof x === 'string' ? x : '')) : [],
  };
}

// ---- Periodic mechanisms (Proposal R5.17) -------------------------------------------

/** A baseline read that failed keeps its error, so only the check that needs it fails. */
export type Baseline<T> = T | { error: string };

/** Cron as read: the user's entries, or that cron is not installed, with the two reads that showed it. */
export type CronState = { available: true; entries: string[] } | { available: false; evidence: string };

export interface Periodic {
  /** `systemctl --user list-unit-files`; `[]` when no user manager ran (`manager: false`). */
  units: { name: string; state: string }[];
  /** `systemctl --user list-timers --all`: every loaded timer, transient ones included. */
  timers: string[];
  cron: CronState;
  manager: boolean;
}

/** Prints exactly one marker: whether a `crontab` command exists. */
export const CRONTAB_PROBE = 'if command -v crontab >/dev/null 2>&1; then echo nibfin-e2e:crontab=present; else echo nibfin-e2e:crontab=absent; fi';

/** One fixed read: fixed words, or the constant probe script. */
export type PeriodicCommand = { readonly words: readonly string[] } | { readonly script: string };

export const PERIODIC_COMMANDS = {
  units: { words: ['systemctl', '--user', 'list-unit-files', '--no-legend', '--plain'] },
  timers: { words: ['systemctl', '--user', 'list-timers', '--all', '--no-legend', '--plain'] },
  probe: { script: CRONTAB_PROBE },
  crontab: { words: ['crontab', '-l'] },
  cronUnits: { words: ['systemctl', 'list-unit-files', '--no-legend', '--plain', '--type=service'] },
} as const satisfies Record<string, PeriodicCommand>;

/** Runs one command of {@link PERIODIC_COMMANDS}. */
export type PeriodicRun = (command: PeriodicCommand) => Promise<ExecResult>;

export const CRON_UNITS = ['cron.service', 'crond.service'];

const describeCommand = (command: PeriodicCommand) => ('words' in command ? command.words.join(' ') : 'the crontab probe');
const outputOf = (r: ExecResult) => [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join(' | ').slice(-2000) || 'no output';
const readFailed = (command: PeriodicCommand, r: ExecResult, why = `exited ${r.code}`) => new Error(`${describeCommand(command)} ${why}: ${outputOf(r)}`);

/** The timers `list-timers` shows: the first token of each line that ends in `.timer`; any other line throws. */
export function parseTimerList(stdout: string): string[] {
  const timers = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '' || /^\d+ timers? listed\.?$/i.test(line)) continue;
    const unit = line.split(/\s+/).find((t) => t.endsWith('.timer'));
    if (unit === undefined) throw new Error(`unreadable timer line: ${line.slice(0, 300)}`);
    timers.add(unit);
  }
  return [...timers].sort();
}

/** The probe's answer; anything but exit 0 with exactly one marker line throws. */
export function parseCrontabProbe(r: ExecResult): 'present' | 'absent' {
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const m = lines.length === 1 ? /^nibfin-e2e:crontab=(present|absent)$/.exec(lines[0] as string) : null;
  if (r.code !== 0) throw readFailed(PERIODIC_COMMANDS.probe, r);
  if (!m) throw readFailed(PERIODIC_COMMANDS.probe, r, 'printed no single marker');
  return m[1] as 'present' | 'absent';
}

/** `crontab -l`: its non-comment lines; `no crontab for <user>` is an empty crontab; any other failure throws. */
export function parseCrontab(r: ExecResult): string[] {
  if (r.code === 0) return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  if (/no crontab for /i.test(`${r.stderr}\n${r.stdout}`)) return [];
  throw readFailed(PERIODIC_COMMANDS.crontab, r);
}

/**
 * The cron units among every service unit file. The read has no unit patterns, so it
 * succeeds whether or not a cron unit exists; a failed or empty list throws.
 */
export function parseCronUnits(r: ExecResult): string[] {
  if (r.code !== 0) throw readFailed(PERIODIC_COMMANDS.cronUnits, r);
  const units = parseUnitFiles(r.stdout);
  if (!units.length) throw readFailed(PERIODIC_COMMANDS.cronUnits, r, 'read no service unit files');
  return units.filter((u) => CRON_UNITS.includes(u.name)).map((u) => u.name);
}

/** Cron: the crontab when `crontab` exists; otherwise "not installed" only when no cron unit exists either. */
export async function readCron(run: PeriodicRun): Promise<CronState> {
  const probe = parseCrontabProbe(await run(PERIODIC_COMMANDS.probe));
  if (probe === 'present') return { available: true, entries: parseCrontab(await run(PERIODIC_COMMANDS.crontab)) };
  const r = await run(PERIODIC_COMMANDS.cronUnits);
  const found = parseCronUnits(r);
  if (found.length) throw new Error(`there is no crontab command, but the service unit files list ${found.join(', ')}`);
  return { available: false, evidence: `no crontab command (nibfin-e2e:crontab=absent) and no ${CRON_UNITS.join('/')} among ${parseUnitFiles(r.stdout).length} service unit files` };
}

/**
 * The user's periodic mechanisms: user unit files, loaded timers and the crontab. Every read
 * must succeed. Only with `noManagerOk` (the caller found no user manager) does a failed unit
 * read give no units and no timers, with `manager: false`; cron is always read. No exit code
 * is taken as "not installed".
 */
export async function readPeriodic(run: PeriodicRun, options: { noManagerOk: boolean }): Promise<Periodic> {
  const listed = await run(PERIODIC_COMMANDS.units);
  if (listed.code !== 0 && options.noManagerOk) return { units: [], timers: [], cron: await readCron(run), manager: false };
  if (listed.code !== 0) throw readFailed(PERIODIC_COMMANDS.units, listed);
  const units = parseUnitFiles(listed.stdout);
  const t = await run(PERIODIC_COMMANDS.timers);
  if (t.code !== 0) throw readFailed(PERIODIC_COMMANDS.timers, t);
  return { units, timers: parseTimerList(t.stdout), cron: await readCron(run), manager: true };
}

/** Runs the periodic reads on the host: words as argv, the probe as `sh -c`, with the user manager's runtime directory. */
export function hostPeriodicRun(run: HostRun, runtime: string | undefined = userRuntimeDir()): PeriodicRun {
  const env = runtime === undefined ? undefined : { XDG_RUNTIME_DIR: runtime };
  return (command) => run('words' in command ? [...command.words] : ['sh', '-c', command.script], env);
}

/**
 * The one remote command string `podman machine ssh` hands to the VM's login shell: the
 * probe script as is, or fixed words joined by spaces. A word that is not shell-safe throws.
 */
export function vmCommand(command: PeriodicCommand): string {
  if (!('words' in command)) return command.script;
  for (const w of command.words) if (!/^[A-Za-z0-9._/=@+-]+$/.test(w)) throw new Error(`vmCommand: ${JSON.stringify(w)} is not a shell-safe word`);
  return command.words.join(' ');
}

export const VM_SSH = ['podman', 'machine', 'ssh', 'podman-machine-default'] as const;

/** The periodic mechanisms inside the podman machine VM (Proposal R5.10): each read is one `podman machine ssh`. */
export function readVmPeriodic(run: HostRun): Promise<Periodic> {
  return readPeriodic((command) => run([...VM_SSH, vmCommand(command)]), { noManagerOk: false });
}

/** Runs `read`; a throw becomes `{ error }`. */
export async function baselineOf<T>(read: () => Promise<T>): Promise<Baseline<T>> {
  try {
    return await read();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
