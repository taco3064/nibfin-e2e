import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, posix } from 'node:path';
import { GitHubError } from '../../src/host/github.ts';
import { readHostState, userRuntimeDir } from '../../src/host/hoststate.ts';
import type { LinuxHostState } from '../../src/host/hoststate.ts';
import type { Scenario } from '../../src/types.ts';
import { Checks } from '../lib/checks.ts';
import type { Projection } from '../lib/containers.ts';
import { registrations } from '../lib/github.ts';
import type { Registration } from '../lib/github.ts';
import type { Kit, KitFor } from '../lib/kit.ts';
import { IMAGE } from '../lib/observed-facts.ts';
import type { ObservedFacts } from '../lib/observed.ts';
import { CLAUDE_VOLUME } from '../lib/volume.ts';
import { newEnabledUnits } from './runner-add-setup.ts';

/** The host reads the checks make; tests replace them. Nothing here writes or follows a symlink. */
export interface HostFs {
  /** `lstat`: undefined when the path does not exist or cannot be read. */
  lstat(path: string): { ctimeMs: number; dir: boolean } | undefined;
  /** Entry names of a directory, or undefined. */
  readdir(path: string): string[] | undefined;
  /** A file's text, or undefined. */
  readFile(path: string): string | undefined;
  /** A symlink's target, or undefined. */
  readlink(path: string): string | undefined;
}

const quiet = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

export const hostFs: HostFs = {
  lstat: (p) => quiet(() => {
    const s = lstatSync(p);
    return { ctimeMs: s.ctimeMs, dir: s.isDirectory() };
  }),
  readdir: (p) => quiet(() => readdirSync(p).sort()),
  readFile: (p) => quiet(() => readFileSync(p, 'utf8')),
  readlink: (p) => quiet(() => readlinkSync(p)),
};

/** The fields of the official runner's registration file `<root>/.runner` the checks use. */
export interface RunnerFile {
  agentId?: number;
  agentName?: string;
  gitHubUrl?: string;
}

/** The value of `name` in `o` regardless of key case: the exact key first, otherwise the first key equal to it ignoring case. */
function field(o: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(o, name)) return o[name];
  const lower = name.toLowerCase();
  const key = Object.keys(o).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : o[key];
}

/**
 * Parses `.runner` (JSON, possibly with a UTF-8 BOM); undefined when it is not a JSON object.
 * The official runner writes camelCase keys (`agentId`, `agentName`, `gitHubUrl`); keys are read
 * regardless of case, so the PascalCase spelling (`AgentId`, ...) is accepted too.
 */
export function parseRunnerFile(text: string): RunnerFile | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const rawId = field(o, 'agentId');
  const name = field(o, 'agentName');
  const url = field(o, 'gitHubUrl');
  const id = typeof rawId === 'number' ? rawId : typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : undefined;
  return {
    agentId: id,
    agentName: typeof name === 'string' ? name : undefined,
    gitHubUrl: typeof url === 'string' ? url : undefined,
  };
}

/** The Listener's own diag log files: `Runner_<yyyyMMdd-HHmmss>-utc.log`. */
export const DIAG_LOG = /^Runner_\d{8}-\d{6}-utc\.log$/;
const VERSION_LINE = /^\[[^\]]*\] Version: (\d+\.\d+\.\d+)\s*$/;

/** The version from the last `[<time> INFO <source>] Version: x.y.z` line of the logs, given in time order. */
export function diagVersion(texts: string[]): string | undefined {
  let found: string | undefined;
  for (const t of texts) for (const line of t.split('\n')) {
    const m = VERSION_LINE.exec(line.replace(/\r$/, ''));
    if (m) found = m[1];
  }
  return found;
}

/** Official runner releases are tagged `v<version>`. */
export const releaseTag = (version: string) => `v${version.replace(/^v/, '')}`;

/** The runner root when `path` is `<root>/bin/Runner.Listener`. */
export function listenerRoot(path: string | undefined): string | undefined {
  if (!path?.startsWith('/')) return undefined;
  // POSIX on every host: the VM's paths read from Windows (runner-location) keep their slashes.
  const p = posix.normalize(path);
  return p.endsWith('/bin/Runner.Listener') ? p.slice(0, -'/bin/Runner.Listener'.length) || '/' : undefined;
}

export interface LocalRunner {
  root: string;
  file?: RunnerFile;
}

/** Local runner roots against the registrations: roots with no registration, and registrations backed by none or several. */
export function matchRunners(local: LocalRunner[], regs: Pick<Registration, 'id' | 'name'>[]) {
  const regOf = (r: LocalRunner) => regs.find((g) => r.file?.agentId === g.id && r.file?.agentName === g.name);
  const unregistered = local.filter((r) => regOf(r) === undefined).map((r) => r.root);
  const backing = (g: Pick<Registration, 'id' | 'name'>) => local.filter((r) => regOf(r) === g).map((r) => r.root);
  const unbacked = regs.filter((g) => backing(g).length === 0).map((g) => g.name);
  const duplicated = regs.filter((g) => backing(g).length > 1).map((g) => `${g.name} (${backing(g).join(', ')})`);
  return { unregistered, unbacked, duplicated };
}

/** True when the URL names the repository (`https://github.com/<owner>/<repo>`, case-insensitive). */
export const urlNamesRepo = (url: string | undefined, repo: string) => !!url && url.replace(/\/+$/, '').toLowerCase().endsWith(`/${repo.toLowerCase()}`);

/**
 * Paths changed after `readAt`: each path that exists with a later ctime, and every such
 * entry under a directory (by `lstat`, so symlinks are not followed).
 */
export function changedSince(fs: HostFs, paths: string[], readAt: number): string[] {
  const out: string[] = [];
  const visit = (p: string) => {
    const s = fs.lstat(p);
    if (!s) return;
    if (s.ctimeMs > readAt) out.push(p);
    if (s.dir) for (const name of fs.readdir(p) ?? []) visit(join(p, name));
  };
  for (const p of paths) visit(p);
  return out;
}

/** Entries directly in each directory whose ctime is after `readAt`; the directory itself is not counted. */
export function newEntries(fs: HostFs, dirs: string[], readAt: number): string[] {
  return dirs.flatMap((d) => (fs.readdir(d) ?? []).map((n) => join(d, n)).filter((p) => (fs.lstat(p)?.ctimeMs ?? 0) > readAt));
}

/** The top-level entries of a package directory, with each `@scope/<name>` entry too. */
export function packageEntries(fs: HostFs, dir: string): string[] {
  return (fs.readdir(dir) ?? []).flatMap((n) => {
    const p = join(dir, n);
    return n.startsWith('@') && fs.lstat(p)?.dir ? [p, ...(fs.readdir(p) ?? []).map((m) => join(p, m))] : [p];
  });
}

/** A mount of the named Podman volume: its name, or a source path inside `/volumes/<name>/`. */
export const mountsVolume = (mounts: Projection['mounts'], name: string) => mounts.some((m) => m.source === name || m.source.includes(`/volumes/${name}/`));

const under = (path: string, base: string) => path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`);

/** The PIDs of a cgroup and its children (`cgroup.procs` files under `/sys/fs/cgroup<cg>`). */
export function cgroupPids(fs: HostFs, cgroup: string): number[] {
  const out: number[] = [];
  const visit = (dir: string) => {
    for (const l of (fs.readFile(join(dir, 'cgroup.procs')) ?? '').split('\n')) if (/^\d+$/.test(l.trim())) out.push(Number(l.trim()));
    for (const n of fs.readdir(dir) ?? []) if (fs.lstat(join(dir, n))?.dir) visit(join(dir, n));
  };
  visit(join('/sys/fs/cgroup', cgroup));
  return out;
}

/** The parent PID from `/proc/<pid>/stat` text; the command name may hold spaces and parentheses. */
export function statParent(text: string): number | undefined {
  const rest = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** `pid` and every descendant, from `/proc/*\/stat`. */
export function descendants(fs: HostFs, pid: number): number[] {
  const parent = new Map<number, number>();
  for (const n of fs.readdir('/proc') ?? []) {
    if (!/^\d+$/.test(n)) continue;
    const p = statParent(fs.readFile(`/proc/${n}/stat`) ?? '');
    if (p !== undefined) parent.set(Number(n), p);
  }
  const out = [pid];
  for (let i = 0; i < out.length; i++) for (const [c, p] of parent) if (p === out[i] && !out.includes(c)) out.push(c);
  return out;
}

/** The runner root a process runs from: `/proc/<pid>/exe`, else an absolute `argv[0]`. */
export function processRoot(fs: HostFs, pid: number): string | undefined {
  return listenerRoot(fs.readlink(`/proc/${pid}/exe`)) ?? listenerRoot((fs.readFile(`/proc/${pid}/cmdline`) ?? '').split('\0')[0]);
}

/** A host command's result; a program that cannot start gives exit -1 with the reason. */
const tryExec = async (kit: Kit, argv: string[]) => {
  try {
    return await kit.exec(argv);
  } catch (error) {
    return { code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
};

const list = (xs: string[], none = 'none') => (xs.length ? xs.join(', ') : none);

/**
 * Proposal R5.9: the host needs only the official GitHub Runner, Podman and a CLI login; it
 * does not install Core, and every Job runs the Core inside the Nibfin image. Reads the host
 * (systemd, /proc, /sys/fs/cgroup, files and lstat metadata) and GitHub; writes nothing and
 * runs no runner binary.
 */
export function hostRequirements(kitFor: KitFor, fs: HostFs = hostFs, home: string = homedir()): Scenario {
  return {
    id: 'host-requirements',
    rules: ['R5.9'],
    platforms: ['linux'],
    requires: ['nibfin', 'observed-job'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const c = new Checks(kit.secrets());
      const nibfin = kit.facts('nibfin') ?? {};
      const before = nibfin.hostBefore as LinuxHostState | undefined;
      const digest = typeof nibfin.imageDigest === 'string' ? nibfin.imageDigest : undefined;
      const f = (kit.facts('observed-job') ?? {}) as unknown as ObservedFacts;
      const execution = kit.sandbox.execution;
      if (!c.hold('R5.9', 'the host state before runner add has a read time and the PATH directories', before?.platform === 'linux' && typeof before.readAt === 'number' && Array.isArray(before.pathDirs), before ? `readAt=${String(before.readAt)}, pathDirs ${Array.isArray(before.pathDirs) ? before.pathDirs.length : 'absent'}` : 'no hostBefore') || !before) {
        return c.outcome();
      }
      const readAt = before.readAt;
      const runtime = userRuntimeDir(kit.env);
      const userEnv = runtime === undefined ? undefined : { XDG_RUNTIME_DIR: runtime };

      // 1. Official Runner.
      const now = await readHostState((argv, env) => kit.exec(argv, { env }), 'linux', { env: kit.env });
      const units = now.platform === 'linux' ? newEnabledUnits(before, now) : [];
      c.hold('R5.9', 'runner add enabled user services', units.length > 0, list(units));
      const local: LocalRunner[] = [];
      for (const u of units) {
        const cg = (await kit.exec(['systemctl', '--user', 'show', '-p', 'ControlGroup', '--value', u], { env: userEnv })).stdout.trim();
        let pids = cg ? cgroupPids(fs, cg) : [];
        let source = `cgroup ${cg || '(none)'}`;
        if (!pids.length) {
          const main = Number((await kit.exec(['systemctl', '--user', 'show', '-p', 'MainPID', '--value', u], { env: userEnv })).stdout.trim());
          pids = main > 0 ? descendants(fs, main) : [];
          source = `MainPID ${main || 'none'} and its descendants`;
        }
        const roots = [...new Set(pids.map((p) => processRoot(fs, p)).filter((r): r is string => r !== undefined))];
        c.hold('R5.9', `user service ${u} runs the official runner's <root>/bin/Runner.Listener`, roots.length > 0, `${source}: ${pids.length} processes, runner roots ${list(roots)}`);
        for (const root of roots) if (!local.some((l) => l.root === root)) local.push({ root });
      }
      const versions = new Set<string>();
      for (const r of local) {
        const text = fs.readFile(join(r.root, '.runner'));
        r.file = text === undefined ? undefined : parseRunnerFile(text);
        c.hold('R5.9', `${r.root}/.runner is the official runner's registration file naming the execution sandbox`, !!r.file && r.file.agentId !== undefined && !!r.file.agentName && urlNamesRepo(r.file.gitHubUrl, execution), r.file ? `AgentId ${String(r.file.agentId)}, AgentName ${r.file.agentName ?? 'none'}, GitHubUrl ${r.file.gitHubUrl ?? 'none'}` : text === undefined ? 'not readable' : 'not a JSON object');
        const diag = join(r.root, '_diag');
        const logs = (fs.readdir(diag) ?? []).filter((n) => DIAG_LOG.test(n) && (fs.lstat(join(diag, n))?.ctimeMs ?? 0) > readAt).sort();
        const version = diagVersion(logs.map((n) => fs.readFile(join(diag, n)) ?? ''));
        if (!c.hold('R5.9', `the Listener's diag log under ${diag} names its version`, version !== undefined, `read ${list(logs, 'no Runner_*-utc.log changed after runner add')}; version ${version ?? 'none'}`) || !version) continue;
        versions.add(version);
      }
      for (const v of versions) {
        const tag = releaseTag(v);
        let status: number;
        try {
          status = (await kit.github.rest('GET', `/repos/actions/runner/releases/tags/${tag}`)).status;
        } catch (error) {
          status = error instanceof GitHubError ? error.status : -1;
        }
        c.hold('R5.9', `runner version ${v} is a published actions/runner release`, status === 200, `GET /repos/actions/runner/releases/tags/${tag} → ${status}`);
      }
      const regs = await registrations(kit.github, execution);
      const m = matchRunners(local, regs);
      c.hold('R5.9', `every local runner root is one of ${execution}'s registrations`, local.length > 0 && m.unregistered.length === 0, `roots without a registration: ${list(m.unregistered)}`);
      c.hold('R5.9', `every registration on ${execution} is backed by exactly one local runner root`, regs.length > 0 && m.unbacked.length === 0 && m.duplicated.length === 0, `registrations ${list(regs.map((g) => g.name))}; without a root: ${list(m.unbacked)}; with several: ${list(m.duplicated)}`);

      // 2. Podman.
      const version = await tryExec(kit, ['podman', '--version']);
      c.hold('R5.9', 'podman --version exits 0 on the host', version.code === 0, version.code === 0 ? version.stdout.trim() : `exit ${version.code}`);
      const which = await tryExec(kit, ['which', 'podman']);
      const podmanPath = which.stdout.trim().split('\n')[0] ?? '';
      c.hold('R5.9', 'podman is on the host PATH from before runner add', which.code === 0 && before.pathDirs.some((d) => normalize(d) === dirname(normalize(podmanPath))), which.code === 0 ? podmanPath : 'which podman found nothing');
      const images = f.jobImages ?? [];
      c.hold('R5.9', 'Podman reported the Shape, Deliver and Review Job containers', images.length >= 3, `${images.length} Job containers`);

      // 3. CLI login in a Podman volume.
      const mounts = f.projection?.mounts ?? [];
      const inspected = await tryExec(kit, ['podman', 'volume', 'inspect', CLAUDE_VOLUME]);
      c.hold('R5.9', `the Shape Job mounts the Podman volume ${CLAUDE_VOLUME}`, mountsVolume(mounts, CLAUDE_VOLUME), list(mounts.map((x) => `${x.source}:${x.destination}`)));
      c.hold('R5.9', `podman volume inspect ${CLAUDE_VOLUME} exits 0`, inspected.code === 0, `exit ${inspected.code}`);
      c.hold('R5.9', 'the login volume holds the CLI login', f.loginAfter?.exists === true && f.loginAfter.hasToken === true, f.loginAfter ? `settings.json ${f.loginAfter.exists ? 'exists' : 'missing'}, token ${f.loginAfter.hasToken ? 'set' : 'unset'}` : 'no login facts');
      const cliPaths = [join(home, '.claude'), join(home, '.claude.json'), join(home, '.codex'), ...[kit.env.CLAUDE_CONFIG_DIR, kit.env.CODEX_HOME].filter((p): p is string => !!p)];
      const hostMounts = mounts.filter((x) => cliPaths.some((p) => under(x.source, p)));
      c.hold('R5.9', 'no Job mount comes from a host CLI home', hostMounts.length === 0, list(hostMounts.map((x) => x.source)));
      const changedLogin = changedSince(fs, cliPaths, readAt);
      c.hold('R5.9', 'no CLI credential or config file appeared or changed on the host after runner add', changedLogin.length === 0, `looked at ${cliPaths.join(', ')}; changed: ${list(changedLogin)}`);

      // 4. No Core on the host; Core from the image.
      const binDirs = [...new Set([...before.pathDirs, join(home, '.local', 'bin'), '/usr/local/bin'].map((d) => normalize(d)))];
      const newBins = newEntries(fs, binDirs, readAt);
      c.hold('R5.9', 'nothing appeared or changed in the host program directories after runner add', newBins.length === 0, `looked in ${binDirs.length} directories (${binDirs.join(', ')}); new: ${list(newBins)}`);
      const pkgDirs: string[] = [];
      const npm = await tryExec(kit, ['npm', 'root', '-g']);
      if (npm.code === 0 && npm.stdout.trim()) pkgDirs.push(npm.stdout.trim());
      const site = await tryExec(kit, ['python3', '-m', 'site', '--user-site']);
      if (site.code === 0 && site.stdout.trim() && fs.lstat(site.stdout.trim())?.dir) pkgDirs.push(site.stdout.trim());
      const newPkgs = pkgDirs.flatMap((d) => packageEntries(fs, d)).filter((p) => (fs.lstat(p)?.ctimeMs ?? 0) > readAt);
      c.hold('R5.9', 'no package appeared or changed in the global npm root or the Python user site after runner add', newPkgs.length === 0, `looked in ${list(pkgDirs, 'no npm root or Python user site')}; new: ${list(newPkgs)}`);
      const ref = digest === undefined ? undefined : `${IMAGE}@${digest}`;
      const others = images.filter((i) => i !== ref);
      c.hold('R5.9', 'every Job container runs the Nibfin image by the pinned digest', ref !== undefined && images.length > 0 && others.length === 0, `expected ${ref ?? 'a pinned digest'}; other images: ${list(others)}`);
      c.hold('R5.9', 'the Job log names the pinned image', digest !== undefined && f.shapeLog?.imageRef?.includes(digest) === true, f.shapeLog?.imageRef ?? 'no "Nibfin image:" line');

      return c.outcome(`runner roots ${list(local.map((l) => l.root))}, version ${list([...versions])}; volume ${CLAUDE_VOLUME}; ${binDirs.length} program and ${pkgDirs.length} package directories checked. `);
    },
  };
}
