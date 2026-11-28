import { join } from 'node:path';
import { PEER_KEY_TITLE_PREFIX, PEER_USER, SANDBOX, requireEnv } from './config.ts';
import { mustRun } from './exec.ts';
import type { Exec, ExecResult } from './exec.ts';
import type { GitHub } from './github.ts';
import { writeClaudeToken } from './login.ts';
import type { HostServices } from './services.ts';
import type { Platform } from '../types.ts';

/**
 * Runs as the peer user's login environment: \`$1\` is the working directory, then the
 * command. The user manager's runtime directory and bus make \`systemctl --user\` and
 * rootless Podman work through sudo. It also sets the XDG config, data, cache and state
 * folders from the peer's \`$HOME\` and unsets \`GH_CONFIG_DIR\`, so gh and Podman never read
 * another user's folders, whatever sudo or PAM passed in. Nothing in it is built from data.
 */
const PRELUDE = [
  'cd -- "${1:-$HOME}" || exit 125',
  'shift',
  'uid=$(id -u)',
  'export XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus"',
  'export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"',
  'unset GH_CONFIG_DIR',
];
/** With a token: its first stdin line becomes GH_TOKEN, so it never appears in an argument. */
const WITH_TOKEN = [...PRELUDE, 'IFS= read -r GH_TOKEN || exit 125', 'export GH_TOKEN', 'exec "$@"'].join('\n');
const WITHOUT_TOKEN = [...PRELUDE, 'exec "$@"'].join('\n');

export interface PeerExecOptions {
  /** Working directory as the peer user; its home when omitted. */
  cwd?: string;
  /** Passed as the peer's GH_TOKEN through the first stdin line. */
  token?: string;
  input?: string;
}

/**
 * The argv and stdin for one command as the peer user. It does not rely on sudo's
 * \`env_reset\` alone: the prelude also resets the XDG folders and \`GH_CONFIG_DIR\`, so the
 * runner user's folders never reach the peer session even when sudo or PAM pass them. The
 * harness-side child also gets only \`childEnv\`.
 */
export function peerArgv(argv: string[], options: PeerExecOptions = {}): { argv: string[]; input: string } {
  const script = options.token === undefined ? WITHOUT_TOKEN : WITH_TOKEN;
  const cwd = options.cwd ?? '';
  const input = options.token === undefined ? (options.input ?? '') : `${options.token}\n${options.input ?? ''}`;
  return { argv: ['sudo', '-u', PEER_USER, '-H', '--', '/bin/sh', '-c', script, 'sh', cwd, ...argv], input };
}

export function peerExec(exec: Exec, argv: string[], options: PeerExecOptions = {}): Promise<ExecResult> {
  const p = peerArgv(argv, options);
  return exec(p.argv, { input: p.input });
}

/** The first range of 65536 ids at or above 100000 that no line of /etc/subuid or /etc/subgid uses. */
export function freeRange(content: string): { start: number; end: number } {
  let start = 100000;
  for (const line of content.split('\n')) {
    const [, s, n] = line.trim().split(':');
    const end = Number(s) + Number(n);
    if (Number.isFinite(end) && end > start) start = end;
  }
  return { start, end: start + 65535 };
}

export interface PeerStat {
  /** Octal permission bits, for example "600". */
  mode: string;
  owner: string;
  type: string;
}

/** The collaborator as scenarios reach it (Issue #300). */
export interface PeerHandle {
  login: string;
  id: number;
  /** Id of this run's SSH key on the collaborator account. */
  keyId: number;
  home: string;
  /** The collaborator's clone of the execution sandbox. */
  dir: string;
  /** `~/.local/share` of the peer user, which the prelude sets as its `XDG_DATA_HOME`. */
  dataHome: string;
  /** `gh nibfin …` in the clone, logged in as the collaborator. */
  ghNibfin(args: string[]): Promise<ExecResult>;
  /** Any command as the peer user, without a GitHub token. */
  run(argv: string[]): Promise<ExecResult>;
  stat(path: string): Promise<PeerStat | undefined>;
  /** Entry names of a directory, or [] when it does not exist. */
  list(dir: string): Promise<string[]>;
  /** A public key file's content; only `.pub` files are read. */
  readPublic(path: string): Promise<string>;
  /** Names of the peer's `nibfin-runner-*` systemd user units, loaded or as files. */
  units(): Promise<string[]>;
  /** GitHub REST as the collaborator account. */
  github: GitHub;
}

const tail = (r: ExecResult) => (r.stderr.trim() || r.stdout.trim()).slice(-2000);

async function peerMust(exec: Exec, argv: string[], options?: PeerExecOptions): Promise<ExecResult> {
  const r = await peerExec(exec, argv, options);
  if (r.code !== 0) throw new Error(`as ${PEER_USER}: ${argv.slice(0, 3).join(' ')} exited ${r.code}: ${tail(r)}`);
  return r;
}

export function createPeerHandle(
  host: HostServices,
  who: { login: string; id: number; keyId: number; home: string },
): PeerHandle {
  const { exec } = host;
  const dir = join(who.home, 'sandbox');
  const run = (argv: string[]) => peerExec(exec, argv);
  return {
    ...who,
    dir,
    dataHome: join(who.home, '.local', 'share'),
    ghNibfin: (args) => peerExec(exec, ['gh', 'nibfin', ...args], { cwd: dir, token: host.peerToken() }),
    run,
    async stat(path) {
      const r = await run(['stat', '-c', '%a %U %F', '--', path]);
      if (r.code !== 0) return undefined;
      const [mode = '', owner = '', ...type] = r.stdout.trim().split(' ');
      return { mode, owner, type: type.join(' ') };
    },
    async list(d) {
      const r = await run(['ls', '-1A', '--', d]);
      if (r.code !== 0) return [];
      return r.stdout.split('\n').filter(Boolean);
    },
    async readPublic(path) {
      if (!path.endsWith('.pub')) throw new Error(`refusing to read ${path}: only public key files are read`);
      return (await peerMust(exec, ['cat', '--', path])).stdout;
    },
    async units() {
      const names = new Set<string>();
      for (const kind of ['list-units', 'list-unit-files']) {
        const r = await run(['systemctl', '--user', kind, '--all', '--plain', '--no-legend', '--no-pager', 'nibfin-runner-*']);
        for (const line of r.stdout.split('\n')) {
          const name = line.trim().split(/\s+/)[0];
          if (name?.startsWith('nibfin-runner-')) names.add(name);
        }
      }
      return [...names].sort();
    },
    github: host.peerGithub,
  };
}

interface Key {
  id: number;
  title: string;
  key: string;
}

/** Deletes this harness's keys (by title prefix) from the collaborator account and reads back; returns what is left. */
export async function deletePeerKeys(gh: GitHub): Promise<string[]> {
  for (const k of await gh.list<Key>('/user/keys')) {
    if (k.title.startsWith(PEER_KEY_TITLE_PREFIX)) await gh.rest('DELETE', `/user/keys/${k.id}`, undefined, [404]);
  }
  return (await gh.list<Key>('/user/keys')).filter((k) => k.title.startsWith(PEER_KEY_TITLE_PREFIX)).map((k) => `${k.title} (${k.id})`);
}

const keyBody = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(' ');

/** Facts the step records as it goes, so teardown knows what to undo. */
export interface PeerFacts {
  login?: string;
  id?: number;
  keyId?: number;
  home?: string;
  userReady?: boolean;
  installed?: boolean;
  cloned?: boolean;
}

/**
 * Prepares the collaborator's side on a Linux host: the peer OS user, its gh-nibfin,
 * its clone of the execution sandbox, its Claude login volume and this run's SSH key on
 * the collaborator account (Issue #300). Fills `facts` as it goes and sets `host.peer`.
 */
export async function preparePeer(host: HostServices, platform: Platform, facts: PeerFacts, now: () => Date = () => new Date()): Promise<string> {
  if (platform !== 'linux') throw new Error('collaborator scenarios are Linux-only');
  const { exec } = host;
  const peerToken = host.peerToken();
  const claudeToken = requireEnv(host.env, 'E2E_CLAUDE_TOKEN');

  // Who the collaborator is and what it may do; fails before any write when it is wrong.
  const { data: me } = await host.peerGithub.rest<{ login: string; id: number }>('GET', '/user');
  facts.login = me.login;
  facts.id = me.id;
  const perm = await host.github.rest<{ permission?: string }>(
    'GET',
    `/repos/${SANDBOX.execution}/collaborators/${encodeURIComponent(me.login)}/permission`,
    undefined,
    [404],
  );
  const permission = perm.status === 404 ? 'none' : String(perm.data.permission);
  if (permission === 'admin') throw new Error(`${me.login} is admin on ${SANDBOX.execution}; the second account must be a write collaborator, not admin`);
  if (permission !== 'write') {
    throw new Error(`${me.login} has ${permission} permission on ${SANDBOX.execution}; it must be invited as a write collaborator (Issue #281)`);
  }

  // The OS user, its subordinate ids for rootless Podman, and its user manager.
  if ((await exec(['id', '-u', PEER_USER])).code !== 0) await mustRun(exec, ['sudo', 'useradd', '-m', '-s', '/bin/bash', PEER_USER]);
  for (const [file, flag] of [['/etc/subuid', '--add-subuids'], ['/etc/subgid', '--add-subgids']] as const) {
    const content = (await exec(['cat', file])).stdout;
    if (content.split('\n').some((l) => l.startsWith(`${PEER_USER}:`))) continue;
    const { start, end } = freeRange(content);
    await mustRun(exec, ['sudo', 'usermod', flag, `${start}-${end}`, PEER_USER]);
  }
  const uid = (await mustRun(exec, ['id', '-u', PEER_USER])).stdout.trim();
  const home = (await mustRun(exec, ['getent', 'passwd', PEER_USER])).stdout.trim().split(':')[5];
  if (!/^\d+$/.test(uid) || !home) throw new Error(`cannot read the uid and home of ${PEER_USER}`);
  facts.home = home;
  await mustRun(exec, ['sudo', 'loginctl', 'enable-linger', PEER_USER]);
  await mustRun(exec, ['sudo', 'systemctl', 'start', `user@${uid}.service`]);
  facts.userReady = true;

  // gh-nibfin, built by the gh-nibfin step, installed as the peer's own extension.
  const ghDir = join(home, 'gh-nibfin');
  await mustRun(exec, ['sudo', 'install', '-d', '-o', PEER_USER, '-g', PEER_USER, '-m', '0755', ghDir]);
  await mustRun(exec, ['sudo', 'install', '-o', PEER_USER, '-g', PEER_USER, '-m', '0755', join(host.workDir(), 'gh-nibfin', 'gh-nibfin'), join(ghDir, 'gh-nibfin')]);
  await peerExec(exec, ['gh', 'extension', 'remove', 'nibfin'], { token: peerToken });
  await peerMust(exec, ['gh', 'extension', 'install', '.'], { cwd: ghDir, token: peerToken });
  await peerMust(exec, ['gh', 'nibfin', '--help'], { token: peerToken });
  facts.installed = true;

  // The collaborator's clone; the execution sandbox is public here, so no credential.
  const dir = join(home, 'sandbox');
  await peerMust(exec, ['rm', '-rf', '--', dir]);
  await peerMust(exec, ['git', 'clone', '--quiet', `https://github.com/${SANDBOX.execution}.git`, dir]);
  facts.cloned = true;

  // The Claude login volume of the peer's rootless Podman; the Runner reuses the Owner's token.
  const asPeer: Exec = (argv, options) => peerExec(exec, argv, { input: options?.input });
  await writeClaudeToken({ ...host, exec: asPeer }, claudeToken, { manageMachine: false });

  // This run's SSH key: generated by the peer user, only its public half is read.
  const gh = host.peerGithub;
  const left = await deletePeerKeys(gh);
  if (left.length) throw new Error(`earlier SSH keys could not be deleted from ${me.login}: ${left.join(', ')}`);
  const ssh = join(home, '.ssh');
  const key = join(ssh, 'id_ed25519');
  await peerMust(exec, ['install', '-d', '-m', '0700', ssh]);
  await peerMust(exec, ['rm', '-f', '--', key, `${key}.pub`]);
  await peerMust(exec, ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'nibfin-e2e-peer', '-f', key]);
  const pub = keyBody((await peerMust(exec, ['cat', '--', `${key}.pub`])).stdout);
  const title = `${PEER_KEY_TITLE_PREFIX}${now().toISOString().replace(/[:.]/g, '-')}`;
  const { data: added } = await gh.rest<Key>('POST', '/user/keys', { title, key: pub });
  facts.keyId = added.id;
  const { data: back } = await gh.rest<Key>('GET', `/user/keys/${added.id}`);
  if (keyBody(back.key) !== pub) throw new Error(`SSH key ${added.id} on ${me.login} does not read back as the generated key`);

  host.peer = createPeerHandle(host, { login: me.login, id: me.id, keyId: added.id, home });
  return `${PEER_USER} (uid ${uid}) has gh-nibfin, a clone of ${SANDBOX.execution} and a Claude login; ${me.login} (write) has SSH key ${title}`;
}

/** Removes the peer's local Runners and this run's SSH key, read back. */
export async function teardownPeer(host: HostServices, facts: PeerFacts | undefined): Promise<string[]> {
  const problems: string[] = [];
  if (facts?.installed) {
    const r = await peerExec(host.exec, ['gh', 'nibfin', 'runner', 'remove', 'claude', '--yes'], { cwd: facts.cloned && facts.home ? join(facts.home, 'sandbox') : facts.home, token: host.peerToken() });
    if (r.code !== 0 && !/no_runners/.test(r.stdout + r.stderr)) problems.push(`as ${PEER_USER}: gh nibfin runner remove claude --yes exited ${r.code}: ${tail(r)}`);
  }
  if (facts?.login !== undefined) {
    const left = await deletePeerKeys(host.peerGithub);
    if (left.length) problems.push(`SSH keys left on ${facts.login}: ${left.join(', ')}`);
  }
  return problems;
}
