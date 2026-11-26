import { join } from 'node:path';
import { GH_NIBFIN_REPO } from './config.ts';
import { mustRun } from './exec.ts';
import type { Platform } from '../types.ts';
import type { HostServices } from './services.ts';

/** Builds gh-nibfin at the commit (Dashboard first, since the binary embeds it) and installs it as a local extension. */
export async function installGhNibfin(host: HostServices, commit: string, platform: Platform): Promise<string> {
  const dir = join(host.workDir(), 'gh-nibfin');
  const { exec } = host;
  await mustRun(exec, ['git', 'clone', '--quiet', GH_NIBFIN_REPO, dir]);
  await mustRun(exec, ['git', 'checkout', '--quiet', '--detach', commit], { cwd: dir });
  const head = (await mustRun(exec, ['git', 'rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  if (head !== commit) throw new Error(`gh-nibfin checkout is at ${head}, expected ${commit}`);
  const dashboard = join(dir, 'dashboard');
  await mustRun(exec, ['npm', 'ci'], { cwd: dashboard });
  await mustRun(exec, ['npm', 'run', 'build'], { cwd: dashboard });
  await mustRun(exec, ['go', 'build', '-trimpath', '-o', platform === 'windows' ? 'gh-nibfin.exe' : 'gh-nibfin', '.'], { cwd: dir });
  const ghToken = host.sandboxToken();
  // A leftover install of the same name would make `install` fail; none exists on a fresh host.
  await exec(['gh', 'extension', 'remove', 'nibfin'], { ghToken });
  await mustRun(exec, ['gh', 'extension', 'install', '.'], { cwd: dir, ghToken });
  await mustRun(exec, ['gh', 'nibfin', '--help'], { ghToken });
  return `gh-nibfin ${commit} built and installed`;
}
