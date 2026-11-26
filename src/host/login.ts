import { CLAUDE_VOLUME, HELPER_IMAGE, requireEnv } from './config.ts';
import { mustRun } from './exec.ts';
import type { Platform } from '../types.ts';
import type { HostServices } from './services.ts';

const MOUNT = `${CLAUDE_VOLUME}:/v`;

/** Prints the volume root's and settings.json's "uid mode" (or "-"), then the file. */
const READ = 'stat -c "%u %a" /v; if [ -e /v/settings.json ]; then stat -c "%u %a" /v/settings.json; cat /v/settings.json; else echo -; fi';
/** Replaces the file's content from stdin: an existing file keeps its owner and mode, a new one is created 0600. */
const WRITE = 'umask 077 && cat > /v/settings.json';

interface Snapshot {
  root: string;
  file?: string;
  settings?: Record<string, unknown>;
}

function parse(stdout: string): Snapshot {
  const [root = '', file = '-', ...rest] = stdout.split('\n');
  if (file.trim() === '-') return { root: root.trim() };
  let settings: unknown;
  try {
    settings = JSON.parse(rest.join('\n'));
  } catch {
    throw new Error(`${CLAUDE_VOLUME}/settings.json is not valid JSON`);
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`${CLAUDE_VOLUME}/settings.json is not a JSON object`);
  }
  return { root: root.trim(), file: file.trim(), settings: settings as Record<string, unknown> };
}

/** In Podman's default rootless user namespace container root is the host user, shown as uid 0. */
const HOST_USER = '0';

/**
 * Writes the Claude subscription token into the login volume's settings.json `env`,
 * the CLI's own config home (Proposal R6.12). Every other key is kept. The token goes
 * to the helper container on stdin only and is never printed.
 */
export async function writeClaudeLogin(host: HostServices, platform: Platform): Promise<string> {
  const token = requireEnv(host.env, 'E2E_CLAUDE_TOKEN');
  const { exec } = host;
  const podman = (args: string[], input?: string) => mustRun(exec, ['podman', ...args], { input, hideStdout: true });
  if (platform === 'windows') await podman(['machine', 'start']);
  try {
    await podman(['volume', 'create', '--ignore', CLAUDE_VOLUME]);
    const helper = ['run', '--rm', '-v', MOUNT, HELPER_IMAGE, 'sh', '-c'];
    const before = parse((await podman([...helper, READ])).stdout);
    const settings = before.settings ?? {};
    const env = typeof settings.env === 'object' && settings.env !== null && !Array.isArray(settings.env) ? settings.env : {};
    const merged = { ...settings, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token } };
    await podman(['run', '--rm', '-i', '-v', MOUNT, HELPER_IMAGE, 'sh', '-c', WRITE], JSON.stringify(merged, null, 2) + '\n');

    const after = parse((await podman([...helper, READ])).stdout);
    const expectedFile = before.file ?? `${HOST_USER} 600`;
    const problems: string[] = [];
    const [rootUid, rootMode = '0'] = after.root.split(' ');
    if (rootUid !== HOST_USER || !(parseInt(rootMode, 8) & 0o200)) problems.push(`volume root is "${after.root}", expected owned and writable by the host user`);
    if (after.file !== expectedFile) problems.push(`settings.json is "${String(after.file)}", expected "${expectedFile}" (uid mode)`);
    const readEnv = after.settings?.env as Record<string, unknown> | undefined;
    if (readEnv?.CLAUDE_CODE_OAUTH_TOKEN !== token) problems.push('settings.json env has no CLAUDE_CODE_OAUTH_TOKEN with the given token');
    for (const k of Object.keys(settings)) if (!(k in (after.settings ?? {}))) problems.push(`settings.json lost key ${k}`);
    if (problems.length) throw new Error(`login volume read-back: ${problems.join('; ')}`);
    return `${CLAUDE_VOLUME}/settings.json has the token in env (owner and mode ${after.file})`;
  } finally {
    if (platform === 'windows') await exec(['podman', 'machine', 'stop']);
  }
}
