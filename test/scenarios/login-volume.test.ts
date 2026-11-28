import { deepEqual, equal, match, ok, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import type { Projection } from '../../scenarios/lib/containers.ts';
import type { ObservedFacts, ObservedJob } from '../../scenarios/lib/observed.ts';
import { changedFiles, inspectVolume, parseVolumeStat, statVolume } from '../../scenarios/lib/volume.ts';
import type { VolumeFile } from '../../scenarios/lib/volume.ts';
import { cliHome, loginMounts, loginVolume } from '../../scenarios/login-volume.ts';
import type { RunContext } from '../../src/types.ts';
import { fakeHostContext } from '../host/fakes.ts';
import { EXEC, setup } from './kit.ts';

const MOUNTPOINT = '/home/u/.local/share/containers/storage/volumes/nibfin-home-claude/_data';
const IMAGE = 'ghcr.io/taco3064/nibfin@sha256:' + 'd'.repeat(64);
const LOGIN = {
  exists: true,
  hasToken: true,
  enableAllProjectMcpServers: true,
  sandboxEnabled: undefined,
  keys: ['enableAllProjectMcpServers', 'env'],
};

const file = (path: string, size: number, mtime: number): VolumeFile => ({ path, size, mtime });
const projection = (mounts: Projection['mounts'], extra: Partial<Projection> = {}): Projection => ({
  imageName: IMAGE,
  memory: 1,
  nanoCpus: 1,
  cpuQuota: 0,
  pidsLimit: 1,
  mounts,
  credentialEnv: [],
  ...extra,
});
const homeMount = {
  source: MOUNTPOINT,
  destination: '/home/nibfin/.claude',
  name: 'nibfin-home-claude',
  type: 'volume',
};
const job = (stage: string, id: string, p: Projection | null = projection([homeMount])): ObservedJob => ({
  stage,
  id,
  ...(p ? { projection: p } : {}),
});

function facts(over: Partial<ObservedFacts> = {}): ObservedFacts {
  return {
    repo: EXEC,
    probe: { home: ['/home/nibfin'], claude_config_dir: ['unset'] },
    loginAfter: LOGIN,
    loginAfterJobs: LOGIN,
    loginVolume: { name: 'nibfin-home-claude', driver: 'local', mountpoint: MOUNTPOINT },
    volumeFiles: {
      beforeJobs: [file('settings.json', 100, 1)],
      afterShape: [file('projects/-workspace/s1.jsonl', 4096, 5), file('settings.json', 140, 5)],
      afterJobs: [
        file('projects/-workspace/s1.jsonl', 4096, 5),
        file('projects/-workspace/s2.jsonl', 2048, 9),
        file('settings.json', 140, 5),
      ],
    },
    jobs: [job('Shape', 'aaaaaaaaaaaaaaaa1'), job('Deliver', 'bbbbbbbbbbbbbbbb2'), job('Review', 'cccccccccccccccc3')],
    ...over,
  };
}

const ctxWith = (f: ObservedFacts): RunContext => ({
  ...fakeHostContext,
  target: { ghNibfinCommit: 'a'.repeat(40), platform: 'linux' },
  log: () => {},
  defer: () => {},
  upcoming: () => [],
  facts: (id) => (id === 'observed-job' ? (f as unknown as Record<string, unknown>) : undefined),
});
const run = (f: ObservedFacts) => loginVolume.run(ctxWith(f));

test('parseVolumeStat reads size, mtime and path (spaces kept), sorted; a malformed line throws naming it', () => {
  deepEqual(parseVolumeStat('12 1700000000 ./settings.json\n0 1700000001 ./projects/a b/s 1.jsonl\n\n'), [
    file('projects/a b/s 1.jsonl', 0, 1700000001),
    file('settings.json', 12, 1700000000),
  ]);
  deepEqual(parseVolumeStat(''), []);
  throws(() => parseVolumeStat('12 ./settings.json'), /unexpected volume listing line: "12 \.\/settings\.json"/);
  throws(() => parseVolumeStat('stat: unrecognized option'), /unexpected volume listing line/);
  throws(() => parseVolumeStat('1 2 .'), /unexpected volume listing line/);
});

test('changedFiles lists new files and size or mtime changes, leaving out settings.json and decoys', () => {
  const before = [
    file('settings.json', 1, 1),
    file('same', 3, 3),
    file('grow', 1, 1),
    file('touch', 1, 1),
    file('e2e-decoy-old', 0, 1),
  ];
  const after = [
    file('settings.json', 9, 9),
    file('same', 3, 3),
    file('grow', 2, 1),
    file('touch', 1, 2),
    file('new', 1, 1),
    file('e2e-decoy-login', 0, 2),
    file('sub/e2e-decoy-x', 0, 2),
    file('sub/settings.json', 1, 1),
  ];
  deepEqual(changedFiles(before, after), ['grow', 'touch', 'new', 'sub/settings.json']);
  deepEqual(changedFiles(after, after), []);
});

test('statVolume and inspectVolume read through Podman read-only and fail with the command output', async () => {
  let fail = false;
  const h = setup({
    respond: (argv) => {
      if (fail) return { code: 125, stderr: 'Error: no such volume' };
      if (argv[1] === 'volume')
        return { stdout: JSON.stringify([{ Name: 'nibfin-home-claude', Driver: 'local', Mountpoint: MOUNTPOINT }]) };
      return { stdout: '5 7 ./settings.json\n' };
    },
  });
  deepEqual(await statVolume(h.kit.exec, 'nibfin-home-claude'), [file('settings.json', 5, 7)]);
  deepEqual(await inspectVolume(h.kit.exec, 'nibfin-home-claude'), {
    name: 'nibfin-home-claude',
    driver: 'local',
    mountpoint: MOUNTPOINT,
  });
  const helper = h.calls.find((c) => c.argv.includes('run'))?.argv ?? [];
  ok(helper.includes('--rm') && helper.includes('nibfin-home-claude:/v:ro'), helper.join(' '));
  ok(!/\bcat\b|head|tail/.test(helper.at(-1) ?? ''), 'the listing reads no file content');
  fail = true;
  await rejects(
    statVolume(h.kit.exec, 'nibfin-home-claude'),
    /listing the files of nibfin-home-claude exited 125: Error: no such volume/,
  );
  await rejects(
    inspectVolume(h.kit.exec, 'nibfin-home-claude'),
    /podman volume inspect nibfin-home-claude exited 125: Error: no such volume/,
  );
});

test('the CLI home is CLAUDE_CONFIG_DIR when set, else ~/.claude; the login mount is found by name or mountpoint', () => {
  equal(cliHome({ home: ['/home/nibfin'], claude_config_dir: ['unset'] }), '/home/nibfin/.claude');
  equal(cliHome({ home: ['/home/nibfin/'], claude_config_dir: ['/data/claude/'] }), '/data/claude');
  equal(cliHome({ home: ['/root'] }), '/root/.claude');
  equal(cliHome({}), undefined);
  const volume = { name: 'nibfin-home-claude', driver: 'local', mountpoint: MOUNTPOINT };
  const p = projection([
    { source: '/w', destination: '/workspace', type: 'bind' },
    { source: MOUNTPOINT, destination: '/h' },
    { source: '/x', destination: '/y', name: 'nibfin-tools' },
  ]);
  deepEqual(loginMounts(p, volume), [{ source: MOUNTPOINT, destination: '/h' }]);
  deepEqual(loginMounts(p, undefined), []);
  deepEqual(loginMounts(projection([homeMount]), undefined), [homeMount]);
});

test('login-volume passes when every Job mounts the same volume at the CLI home and CLI files persist', async () => {
  const r = await run(facts());
  equal(r.status, 'passed', r.reason);
  match(
    r.reason,
    /every Job container mounts nibfin-home-claude once at the CLI's home \(\/home\/nibfin\/\.claude\) \(Shape aaaaaaaaaaaa: nibfin-home-claude → \/home\/nibfin\/\.claude; Deliver bbbbbbbbbbbb/,
  );
  match(
    r.reason,
    /files written during Shape are still in the volume after Review \(projects\/-workspace\/s1\.jsonl\)/,
  );
});

test('login-volume fails naming the stage, container, mount or file, citing R6.12', async () => {
  const cases: [string, Partial<ObservedFacts>, RegExp][] = [
    [
      'missing projection',
      {
        jobs: [
          job('Shape', 'aaaaaaaaaaaaaaaa1'),
          job('Deliver', 'bbbbbbbbbbbbbbbb2', null),
          job('Review', 'cccccccccccccccc3'),
        ],
      },
      /R6\.12: every Job container was inspected \(observed: Deliver bbbbbbbbbbbb: container ended before it was inspected\)/,
    ],
    [
      'too few Jobs',
      { jobs: [job('Shape', 'aaaaaaaaaaaaaaaa1')] },
      /R6\.12: the Shape, Deliver and Review Job containers were recorded \(observed: Shape aaaaaaaaaaaa\)/,
    ],
    [
      'wrong destination',
      {
        jobs: [
          job('Shape', 'aaaaaaaaaaaaaaaa1'),
          job('Deliver', 'bbbbbbbbbbbbbbbb2'),
          job('Review', 'cccccccccccccccc3', projection([{ ...homeMount, destination: '/home/nibfin' }])),
        ],
      },
      /R6\.12: every Job container mounts nibfin-home-claude once at the CLI's home \(\/home\/nibfin\/\.claude\) \(observed: Review cccccccccccc: nibfin-home-claude:\/home\/nibfin\)/,
    ],
    [
      'different source on Deliver',
      {
        jobs: [
          job('Shape', 'aaaaaaaaaaaaaaaa1'),
          job('Deliver', 'bbbbbbbbbbbbbbbb2', projection([{ ...homeMount, source: '/elsewhere' }])),
          job('Review', 'cccccccccccccccc3'),
        ],
      },
      /R6\.12: every Job container mounts the same volume \(same name and host source\) \(observed: names nibfin-home-claude; sources .*_data, \/elsewhere/,
    ],
    [
      'credential in the environment',
      {
        jobs: [
          job('Shape', 'aaaaaaaaaaaaaaaa1', projection([homeMount], { credentialEnv: ['ANTHROPIC_API_KEY'] })),
          job('Deliver', 'bbbbbbbbbbbbbbbb2'),
          job('Review', 'cccccccccccccccc3'),
        ],
      },
      /R6\.12: no Job container gets a Claude credential through its environment \(observed: Shape aaaaaaaaaaaa: ANTHROPIC_API_KEY\)/,
    ],
    [
      'token gone',
      { loginAfterJobs: { ...LOGIN, hasToken: false } },
      /R6\.12: the login token stays in the volume after Shape and after all Jobs \(observed: after Shape true, after all Jobs false\)/,
    ],
    ['no probe line', { probe: {} }, /R6\.12: the CLI's home is known from the probe \(observed: no probe line/],
    [
      'no changed file',
      {
        volumeFiles: {
          beforeJobs: [file('settings.json', 1, 1)],
          afterShape: [file('settings.json', 2, 2), file('e2e-decoy-login', 0, 2)],
          afterJobs: [],
        },
      },
      /R6\.12: the CLI wrote its own files in its home during Shape \(settings\.json and decoys left out\) \(observed: no file changed\)/,
    ],
    [
      'not persisted',
      {
        volumeFiles: {
          beforeJobs: [],
          afterShape: [file('projects/p/s.jsonl', 1, 1)],
          afterJobs: [file('settings.json', 1, 1)],
        },
      },
      /R6\.12: files written during Shape are still in the volume after Review \(observed: none of projects\/p\/s\.jsonl\)/,
    ],
    [
      'snapshot error',
      {
        volumeFiles: {
          beforeJobs: { error: 'listing the files of nibfin-home-claude exited 1: stat: not found' },
          afterShape: [],
          afterJobs: { error: 'listing the files of nibfin-home-claude exited 125: gone' },
        },
      },
      /R6\.12: the CLI wrote its own files .*\(observed: listing the files of nibfin-home-claude exited 1: stat: not found\).*R6\.12: files written during Shape .*\(observed: listing the files of nibfin-home-claude exited 125: gone\)/,
    ],
    [
      'volume not inspected',
      { loginVolume: { error: 'podman volume inspect nibfin-home-claude exited 125: no such volume' } },
      /R6\.12: nibfin-home-claude is a named Podman volume on the host \(observed: podman volume inspect nibfin-home-claude exited 125: no such volume\)/,
    ],
    [
      'another image',
      {
        jobs: [
          job('Shape', 'aaaaaaaaaaaaaaaa1'),
          job('Deliver', 'bbbbbbbbbbbbbbbb2', projection([homeMount], { imageName: 'other' })),
          job('Review', 'cccccccccccccccc3'),
        ],
      },
      /R6\.12: every Job container runs the same image as Shape.*\(observed: Deliver bbbbbbbbbbbb: other\)/,
    ],
    [
      'no facts recorded',
      { jobs: undefined, volumeFiles: undefined, loginVolume: undefined, loginAfterJobs: undefined },
      /podman volume inspect not read.*Job containers were recorded \(observed: no Job container recorded\)/,
    ],
  ];
  for (const [name, over, expected] of cases) {
    const r = await run(facts(over));
    equal(r.status, 'failed', name);
    match(r.reason, expected, `${name}: ${r.reason}`);
  }
});
