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
}

export interface WindowsHostState {
  platform: 'windows';
  /** `%UserProfile%\.wslconfig`, or null when there is none. */
  wslconfig: string | null;
  /** Every scheduled task as `<TaskPath><TaskName>`. */
  tasks: string[];
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

export interface LinuxReadOptions {
  env?: Record<string, string | undefined>;
  uid?: number;
  user?: string;
  /** Whether a path exists; injectable for tests. */
  exists?: (path: string) => boolean;
  /** `/etc/systemd/system`'s file list; injectable for tests. */
  systemFiles?: () => string[];
}

/**
 * Linux host state. Before `runner add` the user manager may not run and the user may be
 * neither logged in nor lingering, so `systemctl --user` or `loginctl show-user` can fail.
 * Then the state is recorded as no user units (no manager socket in the runtime directory)
 * and linger `no` (no file in /var/lib/systemd/linger). Any other failure still throws.
 */
export async function readLinuxHostState(run: HostRun, options: LinuxReadOptions = {}): Promise<LinuxHostState> {
  const exists = options.exists ?? existsSync;
  const runtime = userRuntimeDir(options.env ?? process.env, options.uid);
  const env = runtime === undefined ? undefined : { XDG_RUNTIME_DIR: runtime };
  const user = options.user ?? userInfo().username;

  const unitsArgv = ['systemctl', '--user', 'list-unit-files', '--no-legend', '--plain'];
  const listed = await run(unitsArgv, env);
  let units: { name: string; state: string }[];
  if (listed.code === 0) units = parseUnitFiles(listed.stdout);
  else if (runtime === undefined || (!exists(join(runtime, 'systemd', 'private')) && !exists(join(runtime, 'bus')))) units = [];
  else throw fail(unitsArgv, listed);

  const lingerArgv = ['loginctl', 'show-user', user, '-p', 'Linger', '--value'];
  const shown = await run(lingerArgv, env);
  let linger: string;
  if (shown.code === 0) linger = shown.stdout.trim();
  else if (!exists(join('/var/lib/systemd/linger', user))) linger = 'no';
  else throw fail(lingerArgv, shown);

  return { platform: 'linux', units, linger, systemFiles: (options.systemFiles ?? (() => listFiles('/etc/systemd/system')))() };
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
}

const TASK =
  '$t = Get-ScheduledTask -TaskPath $env:NIBFIN_E2E_TASK_PATH -TaskName $env:NIBFIN_E2E_TASK_NAME; ' +
  '@{ actions = @($t.Actions | ForEach-Object { @{ execute = [string]$_.Execute; arguments = [string]$_.Arguments } }); ' +
  'triggers = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) } | ConvertTo-Json -Compress -Depth 4';

/** One scheduled task's actions and trigger kinds; the name reaches PowerShell only through the environment. */
export async function readTask(run: HostRun, fullName: string): Promise<TaskDetail> {
  const cut = fullName.lastIndexOf('\\') + 1;
  const env = { NIBFIN_E2E_TASK_PATH: fullName.slice(0, cut), NIBFIN_E2E_TASK_NAME: fullName.slice(cut) };
  const v = JSON.parse(await must(run, ['powershell', '-NoProfile', '-NonInteractive', '-Command', TASK], env)) as Partial<TaskDetail>;
  return { actions: Array.isArray(v.actions) ? v.actions : [], triggers: Array.isArray(v.triggers) ? v.triggers : [] };
}
