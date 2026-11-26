import { CLAUDE_VOLUME, HELPER_IMAGE } from '../../src/host/config.ts';
import type { Exec } from '../../src/host/exec.ts';
import { readClaudeSettings, updateClaudeSettings } from '../../src/host/login.ts';

/** The tools volume the generated workflow mounts into every Job. */
export const TOOLS_VOLUME = 'nibfin-tools';

/** What scenarios learn from the login volume's settings.json: derived values only, never a token. */
export interface LoginFacts {
  exists: boolean;
  hasToken: boolean;
  enableAllProjectMcpServers: unknown;
  sandboxEnabled: unknown;
  keys: string[];
}

export function loginFacts(settings: Record<string, unknown> | undefined): LoginFacts {
  const s = settings ?? {};
  const env = (typeof s.env === 'object' && s.env !== null ? s.env : {}) as Record<string, unknown>;
  const sandbox = (typeof s.sandbox === 'object' && s.sandbox !== null ? s.sandbox : {}) as Record<string, unknown>;
  return {
    exists: settings !== undefined,
    hasToken: typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN !== '',
    enableAllProjectMcpServers: s.enableAllProjectMcpServers,
    sandboxEnabled: sandbox.enabled,
    keys: Object.keys(s).sort(),
  };
}

export async function readLoginFacts(exec: Exec): Promise<LoginFacts> {
  return loginFacts((await readClaudeSettings(exec)).settings);
}

/** Removes one top-level key from the login settings, keeping every other key; returns the facts after. */
export async function removeLoginKey(exec: Exec, key: string): Promise<LoginFacts> {
  const after = await updateClaudeSettings(
    exec,
    (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== key)),
    (s) => (key in s ? [`settings.json still has ${key}`] : []),
  );
  return loginFacts(after.settings);
}

/** Paths (relative to the volume root) under `path` whose name matches the `find -name` pattern. */
export async function listVolume(exec: Exec, volume: string, path = '.', name = '*'): Promise<string[]> {
  const dir = path === '.' ? '/v' : `/v/${path}`;
  const r = await exec(['podman', 'run', '--rm', '-v', `${volume}:/v:ro`, HELPER_IMAGE, 'sh', '-c', 'if [ -e "$1" ]; then find "$1" -name "$2"; fi', 'sh', dir, name]);
  if (r.code !== 0) throw new Error(`listing ${volume}:${path} exited ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\/v\/?/, '')).sort();
}

export { CLAUDE_VOLUME };
