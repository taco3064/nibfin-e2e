import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { PODMAN_MSI } from './config.ts';
import { envKey, mustRun } from './exec.ts';
import type { Exec, ExecResult } from './exec.ts';
import type { Platform } from '../types.ts';
import type { HostServices } from './services.ts';

/**
 * Where the pinned Podman MSI installs `podman.exe`. Its WiX source at v6.2.1
 * (`contrib/win-installer/wix/podman-main.wxs`) puts `INSTALLDIR` "Podman" under
 * `ProgramFiles6432Folder`: `%ProgramFiles%` for a machine-wide install and
 * `%LocalAppData%\Programs` for a per-user one. The package is `perUserOrMachine`, so a
 * default `/quiet` install is per-user.
 */
export function podmanDirs(env: HostServices['env']): string[] {
  const get = (name: string) => env[envKey(env, name, 'win32')];
  const dirs: string[] = [];
  const programFiles = get('ProgramFiles');
  const localAppData = get('LOCALAPPDATA');
  if (programFiles) dirs.push(win32.join(programFiles, 'Podman'));
  if (localAppData) dirs.push(win32.join(localAppData, 'Programs', 'Podman'));
  return dirs;
}

/**
 * The `podmanDirs` folders that hold `podman.exe` after the install. Throws, naming every
 * folder searched and the MSI log, when none does.
 */
export function findPodman(env: HostServices['env'], log: string, exists: (path: string) => boolean = existsSync): string[] {
  const dirs = podmanDirs(env);
  const installed = dirs.filter((d) => exists(win32.join(d, 'podman.exe')));
  if (!installed.length) throw new Error(`podman.exe not found after install in ${dirs.join(' or ')}; see the MSI log ${log}`);
  return installed;
}

/**
 * Linux: Podman comes with the host. Windows: installs the pinned MSI after checking its
 * sha256, then creates the podman machine when there is none and reports the state
 * `podman machine list` shows. `claude-login` and the VM baseline read stop the machine
 * again, so `runner add` starts it itself (Proposal R5.27).
 */
export async function preparePodman(host: HostServices, platform: Platform): Promise<string> {
  const { exec } = host;
  if (platform === 'macos') throw new Error('macOS host provisioning is not supported (Phase 5)');
  if (platform === 'linux') {
    const v = await mustRun(exec, ['podman', '--version']);
    return v.stdout.trim();
  }
  const res = await host.fetch(PODMAN_MSI.url);
  if (!res.ok) throw new Error(`downloading ${PODMAN_MSI.url} returned ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== PODMAN_MSI.sha256) throw new Error(`Podman MSI checksum mismatch: got sha256:${sum}, expected sha256:${PODMAN_MSI.sha256}`);
  const work = host.workDir();
  const msi = join(work, 'podman-installer-windows-amd64.msi');
  writeFileSync(msi, bytes);
  const log = join(work, 'podman-msi.log');
  await mustRun(exec, ['msiexec', '/i', msi, '/quiet', '/norestart', '/l*v', log]);

  const installed = findPodman(host.env, log);
  const key = envKey(host.env, 'PATH', 'win32');
  host.env[key] = [...installed, host.env[key] ?? ''].join(delimiter);

  const v = await mustRun(exec, ['podman', '--version']);
  const initialised = !(await listMachines(exec)).length;
  if (initialised) await mustRun(exec, ['podman', 'machine', 'init']);
  return `${v.stdout.trim()}; ${await machineReport(exec, initialised)}`;
}

async function listMachines(exec: Exec): Promise<unknown[]> {
  const parsed: unknown = JSON.parse((await mustRun(exec, ['podman', 'machine', 'list', '--format', 'json'])).stdout || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Reads `podman machine list --format json` again and reports each machine's state as
 * listed: its `Name`, then `running`, `starting`, `stopped`, or `state unknown` when
 * `Running` is not a boolean. `initialised` says whether this run created the machine.
 */
export async function machineReport(exec: Exec, initialised: boolean): Promise<string> {
  const states = (await listMachines(exec)).map((m) => {
    const r = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
    const name = typeof r.Name === 'string' && r.Name ? r.Name : 'unnamed machine';
    const state = r.Running === true ? 'running' : r.Starting === true ? 'starting' : r.Running === false ? 'stopped' : 'state unknown';
    return `${name}: ${state}`;
  });
  const head = initialised ? 'podman machine initialised' : 'podman machine already existed';
  return [head, ...(states.length ? states : ['podman machine list shows no machine'])].join('; ');
}

/**
 * The refusal Podman v6.2.1 (the `PODMAN_MSI` pin) prints when the machine is already
 * running: `startLocked` in `pkg/machine/shim/host.go` returns
 * `unable to start "<name>": already running`, and `cmd/podman/root.go` exits with
 * `ExecErrorCodeGeneric` (125) and prints it on stderr after `Error: `. Recheck this text
 * when the Podman pin changes.
 */
const ALREADY_RUNNING = /^Error: unable to start "[^"]+": already running$/m;

/**
 * Runs `podman machine start` once. A start Podman refuses because the machine is already
 * running counts as started: it comes back with code 0, its output kept, and
 * `alreadyRunning: true`. Every other result (another exit code or another message) comes
 * back unchanged.
 */
export async function startPodmanMachine(exec: Exec): Promise<ExecResult & { alreadyRunning: boolean }> {
  const r = await exec(['podman', 'machine', 'start']);
  if (r.code === 125 && ALREADY_RUNNING.test(r.stderr.replace(/\r/g, ''))) return { ...r, code: 0, alreadyRunning: true };
  return { ...r, alreadyRunning: false };
}
