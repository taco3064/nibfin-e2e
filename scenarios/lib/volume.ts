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
  const r = await exec([
    'podman',
    'run',
    '--rm',
    '-v',
    `${volume}:/v:ro`,
    HELPER_IMAGE,
    'sh',
    '-c',
    'if [ -e "$1" ]; then find "$1" -name "$2"; fi',
    'sh',
    dir,
    name,
  ]);
  if (r.code !== 0) throw new Error(`listing ${volume}:${path} exited ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\/v\/?/, ''))
    .sort();
}

/** One regular file of a volume: its path relative to the volume root, size in bytes and mtime in epoch seconds. */
export interface VolumeFile {
  path: string;
  size: number;
  mtime: number;
}

/** Parses `stat -c "%s %Y %n"` lines run from the volume root; a line that is not `<size> <mtime> <path>` throws naming it. */
export function parseVolumeStat(stdout: string): VolumeFile[] {
  const out: VolumeFile[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^(\d+) (\d+) (.+)$/.exec(line);
    if (!m) throw new Error(`unexpected volume listing line: ${JSON.stringify(line.slice(0, 300))}`);
    const path = (m[3] as string).replace(/^\.\//, '');
    if (path === '' || path === '.')
      throw new Error(`unexpected volume listing line: ${JSON.stringify(line.slice(0, 300))}`);
    out.push({ path, size: Number(m[1]), mtime: Number(m[2]) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Names, sizes and mtimes of every regular file in the volume, read through a read-only
 * mount of the pinned helper image; no file content is read.
 */
export async function statVolume(exec: Exec, volume: string): Promise<VolumeFile[]> {
  const r = await exec([
    'podman',
    'run',
    '--rm',
    '-v',
    `${volume}:/v:ro`,
    HELPER_IMAGE,
    'sh',
    '-c',
    'cd /v && find . -type f -exec stat -c "%s %Y %n" {} \\;',
  ]);
  if (r.code !== 0) throw new Error(`listing the files of ${volume} exited ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  return parseVolumeStat(r.stdout);
}

const DECOY_NAME = /^e2e-decoy-/;

/**
 * Paths new in `after` or whose size or mtime changed. The root `settings.json` (written by
 * the harness and merged by Core, Proposal R6.19) and the fixture's `e2e-decoy-*` markers are
 * left out: what remains was written by the CLI.
 */
export function changedFiles(before: VolumeFile[], after: VolumeFile[]): string[] {
  const old = new Map(before.map((f) => [f.path, f]));
  return after
    .filter((f) => f.path !== 'settings.json' && !DECOY_NAME.test(f.path.split('/').at(-1) ?? ''))
    .filter((f) => {
      const o = old.get(f.path);
      return o === undefined || o.size !== f.size || o.mtime !== f.mtime;
    })
    .map((f) => f.path);
}

/** What `podman volume inspect` shows of a named volume. */
export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
}

/** Inspects a named Podman volume; a missing volume or unreadable output throws with the command output. */
export async function inspectVolume(exec: Exec, name: string): Promise<VolumeInfo> {
  const r = await exec(['podman', 'volume', 'inspect', name]);
  if (r.code !== 0) throw new Error(`podman volume inspect ${name} exited ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    throw new Error(`podman volume inspect ${name} printed no JSON: ${r.stdout.trim().slice(0, 2000)}`);
  }
  const v = (Array.isArray(list) ? list[0] : undefined) as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object')
    throw new Error(`podman volume inspect ${name} printed no volume: ${r.stdout.trim().slice(0, 2000)}`);
  return { name: String(v.Name ?? ''), driver: String(v.Driver ?? ''), mountpoint: String(v.Mountpoint ?? '') };
}

export { CLAUDE_VOLUME };
