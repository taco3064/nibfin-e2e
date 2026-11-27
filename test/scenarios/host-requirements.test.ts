import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub } from '../../src/host/github.ts';
import type { RunContext } from '../../src/types.ts';
import type { HostFs } from '../../scenarios/management/host-requirements.ts';
import {
  DIAG_LOG,
  cgroupPids,
  changedSince,
  descendants,
  diagVersion,
  hostRequirements,
  listenerRoot,
  matchRunners,
  mountsVolume,
  newEntries,
  packageEntries,
  parseRunnerFile,
  processRoot,
  releaseTag,
  statParent,
  urlNamesRepo,
} from '../../scenarios/management/host-requirements.ts';
import { jobImagesOf } from '../../scenarios/lib/observed.ts';
import { EXEC, setup } from './kit.ts';

type Entry = { ctimeMs: number; dir?: boolean; text?: string; link?: string };

/** An in-memory host: paths to entries; directories list their direct children. */
function memFs(entries: Record<string, Entry>): HostFs & { entries: Record<string, Entry> } {
  const children = (dir: string) => Object.keys(entries).filter((p) => p !== dir && p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map((p) => p.slice(dir.length + 1));
  return {
    entries,
    lstat: (p) => (entries[p] ? { ctimeMs: entries[p].ctimeMs, dir: entries[p].dir === true } : undefined),
    readdir: (p) => (entries[p]?.dir ? children(p).sort() : undefined),
    readFile: (p) => entries[p]?.text,
    readlink: (p) => entries[p]?.link,
  };
}

test('host requirements: .runner parsing tolerates a BOM and missing fields', () => {
  deepEqual(parseRunnerFile('\uFEFF{"AgentId":7,"AgentName":"h-1","GitHubUrl":"https://github.com/o/exec","PoolId":1}'), { agentId: 7, agentName: 'h-1', gitHubUrl: 'https://github.com/o/exec' });
  deepEqual(parseRunnerFile('{"AgentId":"8"}'), { agentId: 8, agentName: undefined, gitHubUrl: undefined });
  // The official runner writes camelCase keys (its settings go through a camelCase contract resolver).
  const official = '{"agentId":7,"agentName":"h-1","poolId":1,"poolName":"Default","serverUrl":"https://pipelines.actions.githubusercontent.com/x","gitHubUrl":"https://github.com/o/exec","workFolder":"_work"}';
  deepEqual(parseRunnerFile(official), { agentId: 7, agentName: 'h-1', gitHubUrl: 'https://github.com/o/exec' });
  deepEqual(parseRunnerFile(`\uFEFF${official}`), { agentId: 7, agentName: 'h-1', gitHubUrl: 'https://github.com/o/exec' });
  deepEqual(parseRunnerFile('{"agentId":"8"}'), { agentId: 8, agentName: undefined, gitHubUrl: undefined });
  deepEqual(parseRunnerFile('{"agentid":9,"AGENTNAME":"h-9","githubUrl":"https://github.com/o/exec"}'), { agentId: 9, agentName: 'h-9', gitHubUrl: 'https://github.com/o/exec' });
  deepEqual(parseRunnerFile('{"agentId":"x","agentName":3,"gitHubUrl":null}'), { agentId: undefined, agentName: undefined, gitHubUrl: undefined });
  equal(parseRunnerFile('not json'), undefined);
  equal(parseRunnerFile('[1]'), undefined);
});

test('host requirements: the version comes from the last Listener header line', () => {
  const a = '[2026-11-27 01:00:00Z INFO HostContext] Well known directory\n[2026-11-27 01:00:00Z INFO RunnerServer] Version: 2.338.0\r\n';
  const b = '[2026-11-27 02:00:00Z INFO RunnerServer] Version: 2.338.2\n[2026-11-27 02:00:01Z INFO Worker] message: Version: 9.9.9 here\nVersion: 1.0.0\n';
  equal(diagVersion([a]), '2.338.0');
  equal(diagVersion([a, b]), '2.338.2');
  equal(diagVersion(['[x] Version: v2.0.0\n', '']), undefined);
  equal(diagVersion([]), undefined);
  deepEqual([releaseTag('2.338.2'), releaseTag('v2.338.2')], ['v2.338.2', 'v2.338.2']);
  deepEqual(['Runner_20261127-010203-utc.log', 'Worker_20261127-010203-utc.log', 'Runner_x.log'].map((n) => DIAG_LOG.test(n)), [true, false, false]);
});

test('host requirements: runner roots come from the Listener path, and match registrations one to one', () => {
  deepEqual([listenerRoot('/h/r1/bin/Runner.Listener'), listenerRoot('/h/r1/bin/../bin/Runner.Listener'), listenerRoot('bin/Runner.Listener'), listenerRoot('/h/r1/bin/Runner.Worker'), listenerRoot(undefined)], ['/h/r1', '/h/r1', undefined, undefined, undefined]);
  const regs = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  deepEqual(matchRunners([{ root: '/r1', file: { agentId: 1, agentName: 'a' } }, { root: '/r2', file: { agentId: 2, agentName: 'b' } }], regs), { unregistered: [], unbacked: [], duplicated: [] });
  deepEqual(matchRunners([{ root: '/r1', file: { agentId: 1, agentName: 'a' } }, { root: '/r3', file: { agentId: 3, agentName: 'c' } }, { root: '/r4' }], regs), { unregistered: ['/r3', '/r4'], unbacked: ['b'], duplicated: [] });
  deepEqual(matchRunners([{ root: '/r1', file: { agentId: 1, agentName: 'a' } }, { root: '/r1b', file: { agentId: 1, agentName: 'a' } }], regs), { unregistered: [], unbacked: ['b'], duplicated: ['a (/r1, /r1b)'] });
  // The id alone is not enough: the name must match too.
  deepEqual(matchRunners([{ root: '/r1', file: { agentId: 1, agentName: 'b' } }], regs).unregistered, ['/r1']);
  deepEqual([urlNamesRepo('https://github.com/O/Exec/', 'o/exec'), urlNamesRepo('https://github.com/o/exec2', 'o/exec'), urlNamesRepo(undefined, 'o/exec')], [true, false, false]);
});

test('host requirements: processes come from the cgroup tree, or from the main PID and its descendants', () => {
  const fs = memFs({
    '/sys/fs/cgroup/u/r.service': { ctimeMs: 0, dir: true },
    '/sys/fs/cgroup/u/r.service/cgroup.procs': { ctimeMs: 0, text: '10\n11\n' },
    '/sys/fs/cgroup/u/r.service/sub': { ctimeMs: 0, dir: true },
    '/sys/fs/cgroup/u/r.service/sub/cgroup.procs': { ctimeMs: 0, text: '12\n' },
    '/proc': { ctimeMs: 0, dir: true },
    '/proc/10': { ctimeMs: 0, dir: true },
    '/proc/10/stat': { ctimeMs: 0, text: '10 (runsvc.sh) S 1 10' },
    '/proc/11': { ctimeMs: 0, dir: true },
    '/proc/11/stat': { ctimeMs: 0, text: '11 (a (b) c) S 10 10' },
    '/proc/12': { ctimeMs: 0, dir: true },
    '/proc/12/stat': { ctimeMs: 0, text: '12 (Runner.Listener) S 11 10' },
    '/proc/12/exe': { ctimeMs: 0, link: '/h/r1/bin/Runner.Listener' },
    '/proc/11/cmdline': { ctimeMs: 0, text: '/h/r2/bin/../bin/Runner.Listener\0run\0' },
    '/proc/13': { ctimeMs: 0, dir: true },
    '/proc/13/stat': { ctimeMs: 0, text: '13 (other) S 1 13' },
  });
  deepEqual(cgroupPids(fs, '/u/r.service'), [10, 11, 12]);
  deepEqual(cgroupPids(fs, '/none'), []);
  deepEqual([statParent('11 (a (b) c) S 10 10'), statParent('')], [10, undefined]);
  deepEqual(descendants(fs, 10), [10, 11, 12]);
  deepEqual([processRoot(fs, 12), processRoot(fs, 11), processRoot(fs, 10)], ['/h/r1', '/h/r2', undefined]);
});

test('host requirements: changes since runner add are found by ctime, with the exact paths', () => {
  const fs = memFs({
    '/h/.claude': { ctimeMs: 5, dir: true },
    '/h/.claude/settings.json': { ctimeMs: 5 },
    '/h/.claude/sub': { ctimeMs: 5, dir: true },
    '/h/.claude/sub/.credentials.json': { ctimeMs: 20 },
    '/bin': { ctimeMs: 20, dir: true },
    '/bin/old': { ctimeMs: 5 },
    '/bin/new': { ctimeMs: 20 },
    '/npm': { ctimeMs: 5, dir: true },
    '/npm/old': { ctimeMs: 5 },
    '/npm/@s': { ctimeMs: 5, dir: true },
    '/npm/@s/core': { ctimeMs: 20 },
  });
  deepEqual(changedSince(fs, ['/h/.claude', '/h/.claude.json'], 10), ['/h/.claude/sub/.credentials.json']);
  deepEqual(changedSince(fs, ['/h/.claude'], 4), ['/h/.claude', '/h/.claude/settings.json', '/h/.claude/sub', '/h/.claude/sub/.credentials.json']);
  // Only entries count, not the directory's own ctime; a missing directory has none.
  deepEqual(newEntries(fs, ['/bin', '/missing'], 10), ['/bin/new']);
  deepEqual(packageEntries(fs, '/npm'), ['/npm/@s', '/npm/@s/core', '/npm/old']);
  deepEqual(mountsVolume([{ source: 'nibfin-home-claude', destination: '/home' }], 'nibfin-home-claude'), true);
  deepEqual(mountsVolume([{ source: '/h/.local/share/containers/storage/volumes/nibfin-home-claude/_data', destination: '/home' }], 'nibfin-home-claude'), true);
  deepEqual(mountsVolume([{ source: '/h/.claude', destination: '/home' }, { source: 'nibfin-home-claude-x', destination: '/x' }], 'nibfin-home-claude'), false);
});

test('host requirements: job images are taken from every inspected start, in order', () => {
  const projections = new Map([['a', { imageName: 'i1' }], ['b', undefined]]) as unknown as Parameters<typeof jobImagesOf>[0]['projections'];
  deepEqual(jobImagesOf({ events: [{ kind: 'start', id: 'a' }, { kind: 'died', id: 'a' }, { kind: 'start', id: 'b' }], projections }), ['i1', '(not inspected)']);
});

const DIGEST = 'sha256:' + 'd'.repeat(64);
const REF = `ghcr.io/taco3064/nibfin@${DIGEST}`;
const BEFORE = { platform: 'linux', units: [{ name: 'a.service', state: 'enabled' }], linger: 'no', systemFiles: [], readAt: 1000, pathDirs: ['/usr/bin', '/bin'] };

function host() {
  const runnerFiles = (n: number): Record<string, Entry> => ({
    [`/sys/fs/cgroup/u/r${n}.service`]: { ctimeMs: 0, dir: true },
    [`/sys/fs/cgroup/u/r${n}.service/cgroup.procs`]: { ctimeMs: 0, text: `${n}01\n${n}02\n` },
    [`/proc/${n}01/exe`]: { ctimeMs: 0, link: `/h/runners/r${n}/externals/node20/bin/node` },
    [`/proc/${n}02/exe`]: { ctimeMs: 0, link: `/h/runners/r${n}/bin/Runner.Listener` },
    [`/h/runners/r${n}/.runner`]: { ctimeMs: 1500, text: `\uFEFF${JSON.stringify({ agentId: n, agentName: `myhost-1a2b3c4d-claude-${n}`, gitHubUrl: `https://github.com/${EXEC}` })}` },
    [`/h/runners/r${n}/_diag`]: { ctimeMs: 1500, dir: true },
    [`/h/runners/r${n}/_diag/Runner_20261127-010000-utc.log`]: { ctimeMs: 1600, text: '[2026-11-27 01:00:00Z INFO RunnerServer] Version: 2.338.2\n' },
    [`/h/runners/r${n}/_diag/Worker_20261127-010000-utc.log`]: { ctimeMs: 1600, text: '[2026-11-27 01:00:00Z INFO Worker] Version: 9.9.9\n' },
  });
  return memFs({
    ...runnerFiles(1),
    ...runnerFiles(2),
    '/usr/bin': { ctimeMs: 10, dir: true },
    '/usr/bin/podman': { ctimeMs: 10 },
    '/bin': { ctimeMs: 10, dir: true },
    '/usr/local/bin': { ctimeMs: 10, dir: true },
    '/usr/lib/node_modules': { ctimeMs: 10, dir: true },
    '/usr/lib/node_modules/npm': { ctimeMs: 10 },
  });
}

function scenario(fs: HostFs, opts: { observed?: Record<string, unknown>; release?: number } = {}) {
  const h = setup({
    respond: (argv) => {
      const a = argv.join(' ');
      if (a.startsWith('systemctl --user list-unit-files')) return { stdout: 'a.service enabled enabled\nr1.service enabled enabled\nr2.service enabled enabled\n' };
      if (a.startsWith('loginctl')) return { stdout: 'yes\n' };
      if (a.startsWith('systemctl --user show -p ControlGroup')) return { stdout: `/u/${argv.at(-1)}\n` };
      if (a === 'podman --version') return { stdout: 'podman version 4.9.3\n' };
      if (a === 'which podman') return { stdout: '/usr/bin/podman\n' };
      if (a === 'npm root -g') return { stdout: '/usr/lib/node_modules\n' };
      if (a.startsWith('python3')) return { stdout: '/h/.local/lib/python3.12/site-packages\n' };
      return undefined;
    },
  });
  const original = h.fake.fetch;
  const asked: string[] = [];
  h.kit.github = createGitHub(() => 'tok', async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/repos/actions/runner/releases/tags/')) {
      asked.push(url.pathname);
      return new Response(JSON.stringify({ tag_name: url.pathname.split('/').at(-1) }), { status: opts.release ?? 200 });
    }
    return original(input, init);
  });
  const observed = {
    repo: EXEC,
    projection: { imageName: REF, memory: 1, nanoCpus: 1, cpuQuota: 0, pidsLimit: 1, mounts: [{ source: 'nibfin-home-claude', destination: '/home/nibfin' }, { source: 'nibfin-tools', destination: '/opt/tools' }] },
    jobImages: [REF, REF, REF],
    loginAfter: { exists: true, hasToken: true, enableAllProjectMcpServers: true, sandboxEnabled: false, keys: ['env'] },
    shapeLog: { imageRef: REF, init: [], slot: 'claude-1' },
    ...opts.observed,
  };
  h.kit.env = { HOME: '/h', PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1001' };
  h.kit.facts = (id) => (id === 'nibfin' ? { imageDigest: DIGEST, hostBefore: BEFORE } : id === 'observed-job' ? observed : undefined);
  const s = hostRequirements(() => h.kit, fs, '/h');
  return { h, asked, run: () => s.run({} as RunContext) };
}

test('host-requirements passes on a host with only the Runner, Podman and the login volume', async () => {
  const { h, asked, run } = scenario(host());
  const out = await run();
  equal(out.status, 'passed', out.reason);
  match(out.reason, /runner roots \/h\/runners\/r1, \/h\/runners\/r2, version 2\.338\.2; volume nibfin-home-claude/);
  deepEqual(asked, ['/repos/actions/runner/releases/tags/v2.338.2']);
  // Only reads: no runner binary runs and nothing is written.
  ok(h.calls.every((c) => !/Runner\.|config\.sh|run\.sh/.test(c.argv.join(' '))));
  ok(h.calls.every((c) => ['systemctl', 'loginctl', 'podman', 'which', 'npm', 'python3'].includes(c.argv[0] as string)), h.calls.map((c) => c.argv.join(' ')).join('\n'));
  ok(h.calls.filter((c) => c.argv[0] === 'podman').every((c) => ['--version', 'volume'].includes(c.argv[1] as string)));
});

test('host-requirements fails naming each change, unmatched registration and other image', async () => {
  const fs = host();
  // A Core-like program and package after runner add, a credential file on the host, and r2's Listener gone.
  fs.entries['/usr/local/bin/core'] = { ctimeMs: 3000 };
  fs.entries['/usr/lib/node_modules/@x'] = { ctimeMs: 10, dir: true };
  fs.entries['/usr/lib/node_modules/@x/core'] = { ctimeMs: 3000 };
  fs.entries['/h/.claude'] = { ctimeMs: 3000, dir: true };
  fs.entries['/h/.claude/.credentials.json'] = { ctimeMs: 3000 };
  fs.entries['/sys/fs/cgroup/u/r2.service/cgroup.procs'] = { ctimeMs: 0, text: '' };
  const { run } = scenario(fs, { observed: { jobImages: [REF, 'ghcr.io/taco3064/nibfin:latest'], projection: { imageName: REF, memory: 1, nanoCpus: 1, cpuQuota: 0, pidsLimit: 1, mounts: [{ source: '/h/.claude', destination: '/home/nibfin/.claude' }] } } });
  const out = await run();
  equal(out.status, 'failed');
  for (const want of [
    /R5\.9: user service r2\.service runs the official runner's <root>\/bin\/Runner\.Listener \(observed: MainPID none and its descendants: 0 processes/,
    /every registration on o\/exec is backed by exactly one local runner root \(observed: [^)]*without a root: myhost-1a2b3c4d-claude-2/,
    /Podman reported the Shape, Deliver and Review Job containers \(observed: 2 Job containers\)/,
    /the Shape Job mounts the Podman volume nibfin-home-claude/,
    /no Job mount comes from a host CLI home \(observed: \/h\/\.claude\)/,
    /changed: \/h\/\.claude, \/h\/\.claude\/\.credentials\.json/,
    /host program directories after runner add \(observed: looked in 4 directories \(\/usr\/bin, \/bin, \/h\/\.local\/bin, \/usr\/local\/bin\); new: \/usr\/local\/bin\/core\)/,
    /looked in \/usr\/lib\/node_modules; new: \/usr\/lib\/node_modules\/@x\/core/,
    /other images: ghcr\.io\/taco3064\/nibfin:latest/,
  ]) match(out.reason, want);
});

test('host-requirements fails when the version is not a published release or the diag log has none', async () => {
  const unpublished = await scenario(host(), { release: 404 }).run();
  equal(unpublished.status, 'failed');
  match(unpublished.reason, /runner version 2\.338\.2 is a published actions\/runner release \(observed: GET \/repos\/actions\/runner\/releases\/tags\/v2\.338\.2 → 404\)/);

  const fs = host();
  // A log from before runner add does not count.
  fs.entries['/h/runners/r1/_diag/Runner_20261127-010000-utc.log'] = { ctimeMs: 500, text: '[t INFO RunnerServer] Version: 2.338.2\n' };
  const stale = await scenario(fs).run();
  equal(stale.status, 'failed');
  match(stale.reason, /the Listener's diag log under \/h\/runners\/r1\/_diag names its version \(observed: read no Runner_\*-utc\.log changed after runner add; version none\)/);
});

test('host-requirements fails at once when the host state before runner add lacks the read time', async () => {
  const { h, run } = scenario(host());
  h.kit.facts = (id) => (id === 'nibfin' ? { imageDigest: DIGEST, hostBefore: { ...BEFORE, readAt: undefined } } : undefined);
  const out = await run();
  equal(out.status, 'failed');
  match(out.reason, /R5\.9: the host state before runner add has a read time/);
  equal(h.calls.length, 0);
});
