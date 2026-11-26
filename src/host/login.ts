import { CLAUDE_VOLUME, HELPER_IMAGE, requireEnv } from './config.ts';
import { mustRun } from './exec.ts';
import type { Exec } from './exec.ts';
import type { Platform } from '../types.ts';
import type { HostServices } from './services.ts';

const MOUNT = `${CLAUDE_VOLUME}:/v`;

/** Prints the volume root's and settings.json's "uid mode" (or "-"), then the file. */
const READ = 'stat -c "%u %a" /v; if [ -e /v/settings.json ]; then stat -c "%u %a" /v/settings.json; cat /v/settings.json; else echo -; fi';
/** Replaces the file's content from stdin: an existing file keeps its owner and mode, a new one is created 0600. */
const WRITE = 'umask 077 && cat > /v/settings.json';

/** The login volume's settings.json as read through the helper container. It may hold the token: never print it. */
export interface ClaudeSettings {
  /** The volume root's "uid mode". */
  root: string;
  /** settings.json's "uid mode", or undefined when the file does not exist. */
  file?: string;
  settings?: Record<string, unknown>;
}

function parse(stdout: string): ClaudeSettings {
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

const podman = (exec: Exec, args: string[], input?: string) => mustRun(exec, ['podman', ...args], { input, hideStdout: true });

/** Reads the login volume's settings.json through the pinned helper image. */
export async function readClaudeSettings(exec: Exec): Promise<ClaudeSettings> {
  return parse((await podman(exec, ['run', '--rm', '-v', MOUNT, HELPER_IMAGE, 'sh', '-c', READ])).stdout);
}

/**
 * Rewrites the login volume's settings.json with `fn(current settings)`, sent to the helper
 * on stdin only, then reads it back: the owner and mode are kept (a new file is 0600 for the
 * host user) and every key `fn` did not delete is still there. Returns the read-back.
 */
export async function updateClaudeSettings(
  exec: Exec,
  fn: (settings: Record<string, unknown>) => Record<string, unknown>,
  check: (after: Record<string, unknown>) => string[] = () => [],
): Promise<ClaudeSettings> {
  await podman(exec, ['volume', 'create', '--ignore', CLAUDE_VOLUME]);
  const before = await readClaudeSettings(exec);
  const settings = before.settings ?? {};
  const next = fn(settings);
  await podman(exec, ['run', '--rm', '-i', '-v', MOUNT, HELPER_IMAGE, 'sh', '-c', WRITE], JSON.stringify(next, null, 2) + '\n');

  const after = await readClaudeSettings(exec);
  const expectedFile = before.file ?? `${HOST_USER} 600`;
  const problems: string[] = [];
  const [rootUid, rootMode = '0'] = after.root.split(' ');
  if (rootUid !== HOST_USER || !(parseInt(rootMode, 8) & 0o200)) problems.push(`volume root is "${after.root}", expected owned and writable by the host user`);
  if (after.file !== expectedFile) problems.push(`settings.json is "${String(after.file)}", expected "${expectedFile}" (uid mode)`);
  for (const k of Object.keys(next)) if (!(k in (after.settings ?? {}))) problems.push(`settings.json lost key ${k}`);
  problems.push(...check(after.settings ?? {}));
  if (problems.length) throw new Error(`login volume read-back: ${problems.join('; ')}`);
  return after;
}

/**
 * Writes the Claude subscription token into the login volume's settings.json `env`,
 * the CLI's own config home (Proposal R6.12). Every other key is kept. The token goes
 * to the helper container on stdin only and is never printed.
 */
export async function writeClaudeLogin(host: HostServices, platform: Platform): Promise<string> {
  const token = requireEnv(host.env, 'E2E_CLAUDE_TOKEN');
  const { exec } = host;
  if (platform === 'windows') await podman(exec, ['machine', 'start']);
  try {
    const after = await updateClaudeSettings(
      exec,
      (settings) => {
        const env = typeof settings.env === 'object' && settings.env !== null && !Array.isArray(settings.env) ? settings.env : {};
        return { ...settings, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token } };
      },
      (s) => ((s.env as Record<string, unknown> | undefined)?.CLAUDE_CODE_OAUTH_TOKEN === token ? [] : ['settings.json env has no CLAUDE_CODE_OAUTH_TOKEN with the given token']),
    );
    return `${CLAUDE_VOLUME}/settings.json has the token in env (owner and mode ${after.file})`;
  } finally {
    if (platform === 'windows') await exec(['podman', 'machine', 'stop']);
  }
}
