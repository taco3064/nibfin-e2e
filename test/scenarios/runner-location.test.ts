import { deepEqual, equal, match, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';
import type { RunContext } from '../../src/types.ts';
import type { HostFs } from '../../scenarios/management/host-requirements.ts';
import { listenerRoot } from '../../scenarios/management/host-requirements.ts';
import {
  DISCOVER,
  hostingRunner,
  isLinuxOs,
  layoutProblems,
  parseShow,
  parseVmReport,
  parseWinList,
  runnerLocation,
  serviceProgram,
  unitOfCgroup,
  winRunnerProblems,
} from '../../scenarios/management/runner-location.ts';
import type { WinProcess, WinService } from '../../scenarios/management/runner-location.ts';
import { readMachine, shQuote, vmExec } from '../../scenarios/lib/vm.ts';
import { EXEC, setup } from './kit.ts';

test('runner location: systemctl show blocks, with blank lines and CRLF', () => {
  deepEqual(
    parseShow(
      'Id=a.service\r\nActiveState=active\r\nFragmentPath=/h/x=y\r\n\r\nId=b.service\r\nActiveState=failed\r\n\r\n\r\n',
    ),
    [
      { Id: 'a.service', ActiveState: 'active', FragmentPath: '/h/x=y' },
      { Id: 'b.service', ActiveState: 'failed' },
    ],
  );
  deepEqual(parseShow(''), []);
});

test('runner location: cgroup paths name the user manager and unit, nothing else', () => {
  deepEqual(unitOfCgroup('0::/user.slice/user-1000.slice/user@1000.service/nibfin-runner-claude-1.service'), {
    uid: 1000,
    unit: 'nibfin-runner-claude-1.service',
  });
  deepEqual(
    unitOfCgroup('/user.slice/user-1000.slice/user@1000.service/app.slice/nibfin-runner-claude-2.service/sub\r'),
    { uid: 1000, unit: 'nibfin-runner-claude-2.service' },
  );
  equal(
    unitOfCgroup('0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-abc.scope/container'),
    undefined,
  );
  equal(unitOfCgroup('0::/machine.slice/libpod-abc.scope'), undefined);
  equal(unitOfCgroup('0::/system.slice/actions.runner.o-r.h.service'), undefined);
  equal(unitOfCgroup('12:pids:/user.slice/user-1000.slice/user@1000.service/app.slice/x.service'), undefined);
  equal(unitOfCgroup('0::/user.slice/user-1000.slice/user@1001.service/x.service'), undefined);
});

const b64 = (s: string) => Buffer.from(s).toString('base64');
const runnerJson = (id: number, slot: string) =>
  JSON.stringify({ agentId: id, agentName: `myhost-1a2b3c4d-${slot}`, gitHubUrl: `https://github.com/${EXEC}` });

test('runner location: the VM report ignores other lines and groups each listener', () => {
  deepEqual(
    parseVmReport(
      'Welcome to Fedora\nnibfin-e2e uid 1000\r\nnibfin-e2e home /home/user\nnibfin-e2e data /home/user/.local/share\n',
    ),
    { uid: 1000, home: '/home/user', data: '/home/user/.local/share', listeners: [] },
  );
  const out = [
    'banner nibfin-e2e uid 5',
    'nibfin-e2e uid 1000',
    'nibfin-e2e listener 10 /home/user/.local/share/nibfin/runners/claude-1/bin/Runner.Listener',
    'nibfin-e2e cgroup 10 0::/user.slice/user-1000.slice/user@1000.service/app.slice/nibfin-runner-claude-1.service',
    `nibfin-e2e runner 10 ${b64(runnerJson(1, 'claude-1'))}`,
    'nibfin-e2e listener 20 /opt/r 2/bin/Runner.Listener',
    'nibfin-e2e cgroup 20 0::/system.slice/r.service',
    'nibfin-e2e runner 20 -',
    'nibfin-e2e cgroup 99 0::/stray',
  ].join('\n');
  const r = parseVmReport(out);
  equal(r.uid, 1000);
  deepEqual(
    r.listeners.map((l) => [l.pid, l.path, l.cgroups.length, l.runner === undefined]),
    [
      [10, '/home/user/.local/share/nibfin/runners/claude-1/bin/Runner.Listener', 1, false],
      [20, '/opt/r 2/bin/Runner.Listener', 1, true],
    ],
  );
  equal(r.listeners[0]?.runner, runnerJson(1, 'claude-1'));
  // The script is fixed text: no machine-specific or quoted value is put into it.
  ok(DISCOVER.includes('/bin/Runner.Listener') && !DISCOVER.includes('\n'));
});

test('runner location: PowerShell lists may be empty, one object or an array', () => {
  deepEqual(parseWinList(''), []);
  deepEqual(parseWinList('\uFEFF{"Name":"a"}\r\n'), [{ Name: 'a' }]);
  deepEqual(parseWinList('[{"Name":"a"},{"Name":"b"}]'), [{ Name: 'a' }, { Name: 'b' }]);
  throws(() => parseWinList('Get-CimInstance : Access denied'), /not JSON: Get-CimInstance/);
});

const HOSTED = 'C:\\actions-runner';
const proc = (
  ProcessId: number,
  ParentProcessId: number,
  Name: string | null,
  ExecutablePath: string | null,
): WinProcess => ({ ProcessId, ParentProcessId, Name, ExecutablePath });
const hostedTree = () => [
  proc(4, 0, 'System', null),
  proc(100, 4, 'Runner.Listener.exe', `${HOSTED}\\bin\\Runner.Listener.exe`),
  proc(200, 100, 'Runner.Worker.exe', `${HOSTED}\\bin\\Runner.Worker.exe`),
  proc(300, 200, 'bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'),
  proc(400, 300, 'node.exe', 'C:\\hostedtoolcache\\node\\node.exe'),
];

test('runner location: the hosting runner is the nearest Runner ancestor of this process', () => {
  const h = hostingRunner(hostedTree(), 400);
  equal(h.process?.ProcessId, 200);
  equal(h.root, HOSTED);
  deepEqual(hostingRunner([proc(1, 0, 'explorer.exe', null), proc(2, 1, 'node.exe', null)], 2), {});
  deepEqual(hostingRunner(hostedTree(), 999), {});
  // A parent cycle stops the walk.
  deepEqual(hostingRunner([proc(1, 2, 'a.exe', null), proc(2, 1, 'b.exe', null), proc(3, 1, 'node.exe', null)], 3), {});
  const empty = hostingRunner([proc(1, 0, 'RUNNER.WORKER.EXE', null), proc(2, 1, 'node.exe', null)], 2);
  equal(empty.process?.ProcessId, 1);
  equal(empty.root, undefined);
});

test('runner location: on the Windows host only the hosting runner may run', () => {
  const svc = (Name: string, PathName: string | null): WinService => ({ Name, State: 'Running', PathName });
  deepEqual(winRunnerProblems(hostedTree(), [], HOSTED), []);
  deepEqual(
    winRunnerProblems(
      hostedTree(),
      [
        svc('actions.runner.hosted', `"${HOSTED}\\bin\\RunnerService.exe"`),
        svc('actions.runner.h2', 'c:\\ACTIONS-RUNNER\\bin\\RunnerService.exe --x'),
      ],
      HOSTED,
    ),
    [],
  );
  equal(serviceProgram('"C:\\a b\\r.exe" run'), 'C:\\a b\\r.exe');
  equal(serviceProgram('C:\\a\\r.exe run'), 'C:\\a\\r.exe');

  const foreign = [
    ...hostedTree(),
    proc(
      500,
      4,
      'Runner.Listener.exe',
      'C:\\Users\\u\\AppData\\Local\\nibfin\\runners\\claude-1\\bin\\Runner.Listener.exe',
    ),
  ];
  const p = winRunnerProblems(foreign, [], HOSTED);
  equal(p.length, 1);
  match(
    p[0] as string,
    /Runner\.Listener\.exe PID 500 from C:\\Users\\u\\AppData\\Local\\nibfin\\runners\\claude-1\\bin\\Runner\.Listener\.exe outside C:\\actions-runner/,
  );
  // A sibling directory sharing the prefix is not under the root.
  equal(
    winRunnerProblems([proc(6, 0, 'Runner.Worker.exe', 'C:\\actions-runner2\\bin\\Runner.Worker.exe')], [], HOSTED)
      .length,
    1,
  );
  match(
    winRunnerProblems([proc(7, 0, 'Runner.Worker.exe', null)], [], HOSTED)[0] as string,
    /Runner\.Worker\.exe PID 7 has no ExecutablePath/,
  );
  match(
    winRunnerProblems([], [svc('actions.runner.o-r.h', 'C:\\r\\bin\\RunnerService.exe')], HOSTED)[0] as string,
    /Windows service actions\.runner\.o-r\.h \(Running\) runs C:\\r\\bin\\RunnerService\.exe outside/,
  );
  match(
    winRunnerProblems([], [svc('actions.runner.o-r.h', '')], HOSTED)[0] as string,
    /actions\.runner\.o-r\.h \(Running\) has no PathName/,
  );
  // With no hosting runner every Runner process and service is a problem.
  equal(
    winRunnerProblems(hostedTree(), [svc('actions.runner.hosted', `${HOSTED}\\bin\\RunnerService.exe`)], undefined)
      .length,
    3,
  );
});

test('runner location: the shared Linux layout', () => {
  const ok1 = {
    slot: 'claude-1',
    registration: 'h-claude-1',
    unit: 'nibfin-runner-claude-1.service',
    root: '/home/u/.local/share/nibfin/runners/claude-1',
    fragment: '/home/u/.config/systemd/user/nibfin-runner-claude-1.service',
    home: '/home/u',
    dataDir: '/home/u/.local/share',
  };
  deepEqual(layoutProblems(ok1), []);
  match(
    layoutProblems({ ...ok1, unit: 'runner.service' })[0] as string,
    /runs in unit runner\.service, expected nibfin-runner-claude-1\.service/,
  );
  match(
    layoutProblems({ ...ok1, root: '/opt/runner' })[0] as string,
    /runs from \/opt\/runner, expected \/home\/u\/\.local\/share\/nibfin\/runners\/claude-1/,
  );
  match(
    layoutProblems({ ...ok1, fragment: '/etc/systemd/user/nibfin-runner-claude-1.service' })[0] as string,
    /loaded from \/etc\/systemd\/user\/.*expected a user unit file under \/home\/u/,
  );
  match(layoutProblems({ ...ok1, fragment: undefined })[0] as string, /\(no FragmentPath\)/);
  match(layoutProblems({ ...ok1, slot: undefined })[0] as string, /has no -claude-<n> slot/);
});

test('runner location: quoting, os and the POSIX listener root', () => {
  equal(shQuote("it's"), `'it'\\''s'`);
  equal(shQuote('a b'), `'a b'`);
  deepEqual(['Linux', 'linux', 'LINUX', 'Windows', '', undefined].map(isLinuxOs), [
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
  equal(listenerRoot('/home/u/r/bin/../bin/Runner.Listener'), '/home/u/r');
});

test('runner location: machine inspect and ssh fail loudly', async () => {
  const exec = (code: number, stdout: string) => async () => ({ code, stdout, stderr: code ? 'boom' : '' });
  deepEqual(await readMachine(exec(0, '[{"Name":"podman-machine-default","State":"running"}]')), {
    name: 'podman-machine-default',
    state: 'running',
  });
  await readMachine(exec(0, '[{"State":"running"}]')).then(
    () => ok(false),
    (e: Error) => match(e.message, /reports no Name/),
  );
  await readMachine(exec(125, '')).then(
    () => ok(false),
    (e: Error) => match(e.message, /podman machine inspect exited 125: boom/),
  );
  await vmExec(exec(255, ''), 'm', 'true').then(
    () => ok(false),
    (e: Error) => match(e.message, /podman machine ssh m … exited 255: boom/),
  );
});

// ---- The scenario against a fake host, GitHub and VM. ----

type Entry = { dir?: boolean; text?: string; link?: string };

function memFs(entries: Record<string, Entry>): HostFs & { entries: Record<string, Entry> } {
  const children = (dir: string) =>
    Object.keys(entries)
      .filter((p) => p !== dir && p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => p.slice(dir.length + 1));
  return {
    entries,
    lstat: (p) => (entries[p] ? { ctimeMs: 0, dir: entries[p].dir === true } : undefined),
    readdir: (p) => (entries[p]?.dir ? children(p).sort() : undefined),
    readFile: (p) => entries[p]?.text,
    readlink: (p) => entries[p]?.link,
  };
}

const UID = 1001;
const DATA = '/h/.local/share';
const cgroupOf = (n: number) =>
  `/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/nibfin-runner-claude-${n}.service`;

function linuxHost() {
  const runner = (n: number): Record<string, Entry> => ({
    [`/sys/fs/cgroup${cgroupOf(n)}`]: { dir: true },
    [`/sys/fs/cgroup${cgroupOf(n)}/cgroup.procs`]: { text: `${n}01\n${n}02\n` },
    [`/proc/${n}01/exe`]: { link: '/usr/bin/bash' },
    [`/proc/${n}02/exe`]: { link: `${DATA}/nibfin/runners/claude-${n}/bin/Runner.Listener` },
    [`/proc/${n}02/ns/pid`]: { link: 'pid:[4026531836]' },
    [`/proc/${n}02/ns/mnt`]: { link: 'mnt:[4026531841]' },
    [`${DATA}/nibfin/runners/claude-${n}/.runner`]: { text: `\uFEFF${runnerJson(n, `claude-${n}`)}` },
  });
  return memFs({
    '/proc/self/ns/pid': { link: 'pid:[4026531836]' },
    '/proc/self/ns/mnt': { link: 'mnt:[4026531841]' },
    ...runner(1),
    ...runner(2),
  });
}

const LINUX_BEFORE = {
  platform: 'linux',
  units: [{ name: 'a.service', state: 'enabled' }],
  linger: 'no',
  systemFiles: [],
  readAt: 1000,
  pathDirs: ['/usr/bin'],
};
const WINDOWS_BEFORE = { platform: 'windows', wslconfig: null, tasks: [] };

interface Opts {
  platform: 'linux' | 'windows';
  fs?: HostFs;
  os?: string;
  show?: (unit: string) => string;
  processes?: WinProcess[];
  services?: WinService[];
  machine?: string;
  ssh?: (script: string) => { code?: number; stdout?: string; stderr?: string };
  powershell?: { code: number; stdout: string };
}

const linuxShow = (unit: string) =>
  `Id=${unit}\nActiveState=active\nUnitFileState=enabled\nControlGroup=${cgroupOf(Number(/claude-(\d+)/.exec(unit)?.[1]))}\nMainPID=1\nFragmentPath=/h/.config/systemd/user/${unit}\n`;

const vmDiscovery = (slots: number[], extra = '') =>
  [
    'Connecting to vm podman-machine-default.',
    'nibfin-e2e uid 1000',
    'nibfin-e2e home /home/user',
    'nibfin-e2e data /home/user/.local/share',
    ...slots.flatMap((n) => [
      `nibfin-e2e listener ${n}0 /home/user/.local/share/nibfin/runners/claude-${n}/bin/Runner.Listener`,
      `nibfin-e2e cgroup ${n}0 0::/user.slice/user-1000.slice/user@1000.service/app.slice/nibfin-runner-claude-${n}.service`,
      `nibfin-e2e runner ${n}0 ${b64(runnerJson(n, `claude-${n}`))}`,
    ]),
    extra,
  ].join('\r\n');

const vmShow = (script: string) =>
  [...script.matchAll(/'([^']+\.service)'/g)]
    .map(
      (m) =>
        `Id=${m[1]}\nActiveState=active\nUnitFileState=enabled\nFragmentPath=/home/user/.config/systemd/user/${m[1]}\n`,
    )
    .join('\n');

function scenario(o: Opts) {
  const h = setup({
    respond: (argv) => {
      const a = argv.join(' ');
      if (a.startsWith('systemctl --user list-unit-files'))
        return {
          stdout:
            'a.service enabled enabled\nnibfin-runner-claude-1.service enabled enabled\nnibfin-runner-claude-2.service enabled enabled\n',
        };
      if (a.startsWith('loginctl')) return { stdout: 'yes\n' };
      if (a.startsWith('systemctl --user show')) return { stdout: (o.show ?? linuxShow)(argv.at(-1) as string) };
      if (argv[0] === 'powershell') {
        if (o.powershell) return o.powershell;
        const script = argv.at(-1) as string;
        return {
          stdout: JSON.stringify(script.includes('Win32_Process') ? (o.processes ?? hostedTree()) : (o.services ?? [])),
        };
      }
      if (a === 'podman machine inspect')
        return { stdout: o.machine ?? '[{"Name":"podman-machine-default","State":"running"}]' };
      if (a.startsWith('podman machine ssh podman-machine-default ')) {
        const script = argv[4] as string;
        if (o.ssh) return o.ssh(script);
        return { stdout: script === DISCOVER ? vmDiscovery([1, 2]) : vmShow(script) };
      }
      return undefined;
    },
  });
  for (const r of h.repo(EXEC).runners) r.os = o.os ?? 'Linux';
  h.kit.env = { HOME: '/h', PATH: '/usr/bin', XDG_RUNTIME_DIR: `/run/user/${UID}` };
  h.kit.facts = (id) =>
    id === 'nibfin' ? { hostBefore: o.platform === 'linux' ? LINUX_BEFORE : WINDOWS_BEFORE } : undefined;
  const s = runnerLocation(() => h.kit, { fs: o.fs ?? linuxHost(), pid: 400, uid: UID });
  return { h, s, run: () => s.run({ target: { platform: o.platform } } as RunContext) };
}

test('runner-location declares R5.10 on linux and windows', () => {
  const { s } = scenario({ platform: 'linux' });
  deepEqual([s.id, s.rules, s.platforms, s.requires], ['runner-location', ['R5.10'], ['linux', 'windows'], ['nibfin']]);
});

test('runner-location passes on Linux when the Runners are host user services', async () => {
  const { h, run } = scenario({ platform: 'linux' });
  const out = await run();
  equal(out.status, 'passed', out.reason);
  match(out.reason, /2 registrations on o\/exec report os Linux/);
  match(
    out.reason,
    /Runners nibfin-runner-claude-1\.service, nibfin-runner-claude-2\.service run as systemd user services directly on the host under user@1001\.service/,
  );
  match(out.reason, /root \/h\/\.local\/share\/nibfin\/runners\/<slot> and unit file under \/h/);
  ok(
    h.calls.every((c) => ['systemctl', 'loginctl'].includes(c.argv[0] as string)),
    h.calls.map((c) => c.argv.join(' ')).join('\n'),
  );
  ok(
    h.calls
      .filter((c) => c.argv[1] === '--user' && c.argv[2] === 'show')
      .every((c) => c.options.env?.XDG_RUNTIME_DIR === `/run/user/${UID}`),
  );
});

test('runner-location fails on Linux naming the unit and registration', async () => {
  const fs = linuxHost();
  // claude-2's Listener lives in a container's namespaces, claude-1 sits in a libpod scope with a foreign root.
  fs.entries['/proc/202/ns/pid'] = { link: 'pid:[4026532000]' };
  fs.entries[`${DATA}/nibfin/runners/claude-1/.runner`] = { text: runnerJson(9, 'claude-9') };
  const { run } = scenario({
    platform: 'linux',
    fs,
    os: 'Windows',
    show: (u) =>
      u.endsWith('claude-1.service')
        ? linuxShow(u)
            .replace(/ControlGroup=.*/, 'ControlGroup=/machine.slice/libpod-abc.scope')
            .replace('ActiveState=active', 'ActiveState=inactive')
        : linuxShow(u),
  });
  const out = await run();
  equal(out.status, 'failed');
  for (const want of [
    /R5\.10: registration myhost-1a2b3c4d-claude-1 reports os Windows in GitHub's runner API, expected Linux/,
    /R5\.10: host user unit nibfin-runner-claude-1\.service is ActiveState=inactive UnitFileState=enabled/,
    /R5\.10: host user unit nibfin-runner-claude-1\.service runs in cgroup \/machine\.slice\/libpod-abc\.scope/,
    /R5\.10: host user unit nibfin-runner-claude-1\.service runs no official runner/,
    /R5\.10: Runner\.Listener PID 202 of nibfin-runner-claude-2\.service is in pid namespace pid:\[4026532000\], the host's is pid:\[4026531836\]/,
    /R5\.10: Linux host: registrations backed by no runner: myhost-1a2b3c4d-claude-1/,
  ])
    match(out.reason, want);
});

test('runner-location fails without the host state of its platform', async () => {
  const { h, s } = scenario({ platform: 'linux' });
  const out = await s.run({ target: { platform: 'windows' } } as RunContext);
  equal(out.status, 'failed');
  match(out.reason, /R5\.10: the nibfin step recorded no windows host state before runner add \(found linux\)/);
  equal(h.calls.length, 0);
});

test('runner-location passes on Windows with the Runners in the VM, excluding the hosting runner', async () => {
  const { h, run } = scenario({ platform: 'windows' });
  const out = await run();
  equal(out.status, 'passed', out.reason);
  match(out.reason, /excluded the runner hosting this job: Runner\.Worker\.exe PID 200 under C:\\actions-runner/);
  match(
    out.reason,
    /Runners nibfin-runner-claude-1\.service, nibfin-runner-claude-2\.service run as systemd user services inside podman machine podman-machine-default under user@1000\.service/,
  );
  match(out.reason, /root \/home\/user\/\.local\/share\/nibfin\/runners\/<slot>/);
  const ssh = h.calls.filter((c) => c.argv[2] === 'ssh').map((c) => c.argv);
  equal(ssh.length, 2);
  ok(ssh.every((a) => a.length === 5 && a[3] === 'podman-machine-default'));
  match(
    ssh[1]?.[4] as string,
    /XDG_RUNTIME_DIR.*systemctl --user show .* 'nibfin-runner-claude-1\.service' 'nibfin-runner-claude-2\.service'$/,
  );
});

test('runner-location says when no hosting runner was found', async () => {
  const out = await scenario({ platform: 'windows', processes: [proc(400, 1, 'node.exe', 'C:\\n\\node.exe')] }).run();
  equal(out.status, 'passed', out.reason);
  match(out.reason, /no hosting runner found/);
});

test('runner-location fails on Windows naming the host Runner, service, VM and registration', async () => {
  const foreignProc = await scenario({
    platform: 'windows',
    processes: [...hostedTree(), proc(500, 4, 'Runner.Listener.exe', 'C:\\Users\\u\\nibfin\\bin\\Runner.Listener.exe')],
  }).run();
  equal(foreignProc.status, 'failed');
  match(
    foreignProc.reason,
    /R5\.10: Windows host runs Runner\.Listener\.exe PID 500 from C:\\Users\\u\\nibfin\\bin\\Runner\.Listener\.exe outside C:\\actions-runner/,
  );

  const foreignSvc = await scenario({
    platform: 'windows',
    services: [{ Name: 'actions.runner.o-exec.h', State: 'Running', PathName: '"C:\\nibfin\\bin\\RunnerService.exe"' }],
  }).run();
  match(
    foreignSvc.reason,
    /R5\.10: Windows service actions\.runner\.o-exec\.h \(Running\) runs "C:\\nibfin\\bin\\RunnerService\.exe" outside/,
  );

  const stopped = await scenario({
    platform: 'windows',
    machine: '[{"Name":"podman-machine-default","State":"stopped"}]',
  }).run();
  match(stopped.reason, /R5\.10: podman machine podman-machine-default is stopped, expected running/);

  const sshFails = await scenario({
    platform: 'windows',
    ssh: () => ({ code: 255, stderr: 'ssh: connect to host localhost port 51234: Connection refused' }),
  }).run();
  equal(sshFails.status, 'failed');
  match(
    sshFails.reason,
    /R5\.10: podman machine ssh podman-machine-default … exited 255: ssh: connect to host localhost port 51234: Connection refused/,
  );

  const psFails = await scenario({
    platform: 'windows',
    powershell: { code: 1, stdout: 'Get-CimInstance : Access denied' },
  }).run();
  match(psFails.reason, /R5\.10: powershell Get-CimInstance Win32_Process exited 1: Get-CimInstance : Access denied/);
  const psNotJson = await scenario({ platform: 'windows', powershell: { code: 0, stdout: 'WARNING: x' } }).run();
  match(psNotJson.reason, /R5\.10: powershell Get-CimInstance Win32_Process printed not JSON: WARNING: x/);

  const missing = await scenario({
    platform: 'windows',
    ssh: (s) => ({ stdout: s === DISCOVER ? vmDiscovery([1]) : vmShow(s) }),
  }).run();
  match(
    missing.reason,
    /R5\.10: podman machine podman-machine-default: registrations backed by no runner: myhost-1a2b3c4d-claude-2/,
  );

  const noUid = await scenario({ platform: 'windows', ssh: () => ({ stdout: 'hello\n' }) }).run();
  match(noUid.reason, /R5\.10: podman machine ssh podman-machine-default printed no uid, home or data line: hello/);

  const inactive = await scenario({
    platform: 'windows',
    ssh: (s) => ({
      stdout: s === DISCOVER ? vmDiscovery([1, 2]) : vmShow(s).replace('ActiveState=active', 'ActiveState=failed'),
    }),
  }).run();
  match(
    inactive.reason,
    /R5\.10: VM user unit nibfin-runner-claude-1\.service is ActiveState=failed UnitFileState=enabled, expected active and enabled/,
  );

  const systemService = await scenario({
    platform: 'windows',
    ssh: (s) => ({
      stdout:
        s === DISCOVER
          ? vmDiscovery([1, 2]).replace(
              '0::/user.slice/user-1000.slice/user@1000.service/app.slice/nibfin-runner-claude-2.service',
              '0::/system.slice/nibfin-runner-claude-2.service',
            )
          : vmShow(s),
    }),
  }).run();
  match(
    systemService.reason,
    /R5\.10: VM Runner\.Listener PID 20 \(\/home\/user\/\.local\/share\/nibfin\/runners\/claude-2\) is in cgroup 0::\/system\.slice\/nibfin-runner-claude-2\.service, expected a \.service unit under user@1000\.service/,
  );
});
