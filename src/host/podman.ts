import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { PODMAN_MSI } from './config.ts';
import { envKey, mustRun } from './exec.ts';
import type { Platform } from '../types.ts';
import type { HostServices } from './services.ts';

/** Where the Podman MSI installs, machine-wide and per-user. */
export function podmanDirs(env: HostServices['env']): string[] {
  const get = (name: string) => env[envKey(env, name, 'win32')];
  const dirs: string[] = [];
  for (const base of [get('ProgramFiles'), get('LOCALAPPDATA') && join(get('LOCALAPPDATA') as string, 'Programs')]) {
    if (base) dirs.push(join(base, 'RedHat', 'Podman'));
  }
  return dirs;
}

/**
 * Linux: Podman comes with the host. Windows: installs the pinned MSI after checking its
 * sha256, then creates a stopped podman machine; `runner add` starts it (Proposal R5.27).
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
  await mustRun(exec, ['msiexec', '/i', msi, '/quiet', '/norestart', '/l*v', join(work, 'podman-msi.log')]);

  const installed = podmanDirs(host.env).filter((d) => existsSync(join(d, 'podman.exe')));
  if (!installed.length) throw new Error(`podman.exe not found after install in ${podmanDirs(host.env).join(' or ')}`);
  const key = envKey(host.env, 'PATH', 'win32');
  host.env[key] = [...installed, host.env[key] ?? ''].join(delimiter);

  const v = await mustRun(exec, ['podman', '--version']);
  const machines = JSON.parse((await mustRun(exec, ['podman', 'machine', 'list', '--format', 'json'])).stdout || '[]') as unknown[];
  if (!machines.length) await mustRun(exec, ['podman', 'machine', 'init']);
  return `${v.stdout.trim()}; podman machine initialised and stopped`;
}
