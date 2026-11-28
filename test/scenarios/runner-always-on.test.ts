import { deepEqual, equal, match, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { readHostState, readRequestsOverride } from '../../src/host/hoststate.ts';
import type { HostRun } from '../../src/host/hoststate.ts';
import {
  afterWaitProblems,
  ALWAYS_ON_WAIT_MS,
  cgroupOf,
  inUserManager,
  nibfinPowerCaller,
  notOnline,
  overrideLines,
  parseInhibitors,
  parsePowerRequests,
  parseShow,
} from '../../scenarios/management/runner-always-on.ts';

test('the idle wait is longer than WSL vmIdleTimeout (60 s)', () => {
  equal(ALWAYS_ON_WAIT_MS > 60_000, true);
});

test('parseInhibitors reads busctl a(ssssuu) JSON and throws on anything else', () => {
  const json = JSON.stringify({
    type: 'a(ssssuu)',
    data: [
      [
        ['sleep', 'NetworkManager', 'NetworkManager needs to turn off networks', 'delay', 0, 812],
        ['sleep:idle', 'podman run', 'keep', 'block', 1001, 4242],
        ['shutdown', 'Unattended Upgrades Shutdown', 'Stop ongoing upgrades', 'delay', 0, 900],
      ],
    ],
  });
  const locks = parseInhibitors(json);
  equal(locks.length, 3);
  deepEqual(locks[1], { what: ['sleep', 'idle'], who: 'podman run', why: 'keep', mode: 'block', uid: 1001, pid: 4242 });
  deepEqual(locks[2]?.what, ['shutdown']);
  deepEqual(parseInhibitors('{"type":"a(ssssuu)","data":[[]]}'), []);
  throws(() => parseInhibitors('Failed to connect to bus'), /not a\(ssssuu\) JSON: Failed to connect/);
  throws(() => parseInhibitors('{"type":"s","data":["x"]}'), /not a\(ssssuu\)/);
  throws(() => parseInhibitors('{"type":"a(ssssuu)","data":[[["sleep","w","y","block",1]]]}'), /not a\(ssssuu\)/);
});

test('parseShow, cgroupOf and inUserManager place a unit under the user manager, not a session', () => {
  deepEqual(
    parseShow(
      'ActiveState=active\nSubState=running\nControlGroup=/user.slice/user-1001.slice/user@1001.service/app.slice/x.service\nMainPID=77\n',
    ),
    {
      ActiveState: 'active',
      SubState: 'running',
      ControlGroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/x.service',
      MainPID: '77',
    },
  );
  equal(
    cgroupOf('0::/user.slice/user-1001.slice/user@1001.service/app.slice/x.service\n'),
    '/user.slice/user-1001.slice/user@1001.service/app.slice/x.service',
  );
  equal(cgroupOf('12:pids:/user.slice\n1:name=systemd:/user.slice/user-1001.slice/session-3.scope\n'), undefined);
  equal(inUserManager('/user.slice/user-1001.slice/user@1001.service/app.slice/x.service', 1001), true);
  equal(inUserManager('/user.slice/user-1001.slice/user@1001.service/app.slice/x.service', 1002), false);
  equal(inUserManager('/user.slice/user-1001.slice/session-3.scope', 1001), false);
  equal(inUserManager('/system.slice/actions.runner.service', 1001), false);
  equal(inUserManager(undefined, 1001), false);
});

test('parsePowerRequests reads sections, entries and their reason lines, CRLF too; no header throws', () => {
  const none = [
    'DISPLAY:',
    'None.',
    '',
    'SYSTEM:',
    'None.',
    '',
    'AWAYMODE:',
    'None.',
    '',
    'EXECUTION:',
    'None.',
    '',
    'PERFBOOST:',
    'None.',
    '',
    'ACTIVELOCKSCREEN:',
    'None.',
    '',
  ].join('\r\n');
  deepEqual(parsePowerRequests(none), []);
  const held = [
    'DISPLAY:',
    'None.',
    '',
    'SYSTEM:',
    '[DRIVER] Legacy Kernel Caller',
    '[PROCESS] \\Device\\HarddiskVolume3\\Windows\\System32\\vmmem',
    'Virtual machine running',
    '',
    'EXECUTION:',
    'None.',
    '',
  ].join('\r\n');
  deepEqual(parsePowerRequests(held), [
    { section: 'SYSTEM', entry: '[DRIVER] Legacy Kernel Caller', detail: '' },
    {
      section: 'SYSTEM',
      entry: '[PROCESS] \\Device\\HarddiskVolume3\\Windows\\System32\\vmmem',
      detail: 'Virtual machine running',
    },
  ]);
  throws(
    () => parsePowerRequests('This command requires administrator privileges'),
    /no known section header: This command requires/,
  );
  throws(() => parsePowerRequests(''), /no known section header: \(empty\)/);
});

test('nibfinPowerCaller matches Podman, WSL and Nibfin but not the hosted agent or a driver', () => {
  for (const s of [
    '[PROCESS] \\Device\\HarddiskVolume3\\Program Files\\RedHat\\Podman\\podman.exe',
    '[PROCESS] \\Device\\HarddiskVolume3\\Program Files\\RedHat\\Podman\\gvproxy.exe',
    '[PROCESS] \\Device\\HarddiskVolume3\\Windows\\System32\\wsl.exe',
    '[PROCESS] \\Device\\HarddiskVolume3\\Program Files\\WSL\\wslservice.exe',
    '[PROCESS] vmmem',
    '[SERVICE] LxssManager',
    '[PROCESS] \\Device\\HarddiskVolume3\\Users\\runner\\AppData\\Local\\GitHub CLI\\extensions\\gh-nibfin\\gh-nibfin.exe',
  ])
    equal(nibfinPowerCaller(s), true, s);
  equal(nibfinPowerCaller('[PROCESS] \\Device\\HarddiskVolume2\\actions-runner\\bin\\Runner.Listener.exe'), false);
  equal(nibfinPowerCaller('[DRIVER] Legacy Kernel Caller'), false);
});

test('overrideLines skips headers and blanks; gained lines are found', () => {
  const before = '[SERVICE]\r\n\r\n[PROCESS]\r\n\r\n[DRIVER]\r\n';
  deepEqual(overrideLines(before), []);
  const now = '[SERVICE]\r\n\r\n[PROCESS]\r\nwsl.exe SYSTEM\r\n\r\n[DRIVER]\r\n';
  const had = new Set(overrideLines(before));
  deepEqual(
    overrideLines(now).filter((l) => !had.has(l)),
    ['[PROCESS] wsl.exe SYSTEM'],
  );
});

test('registrations: a listed offline one is reported before the wait and again only when it changes', () => {
  deepEqual(
    notOnline([
      { name: 'a', status: 'online' },
      { name: 'b', status: 'offline' },
    ]),
    [{ name: 'b', status: 'offline' }],
  );
  deepEqual(notOnline([]), []);
  const before = [
    { name: 'a', status: 'online' },
    { name: 'b', status: 'offline' },
    { name: 'c', status: 'online' },
  ];
  const p = afterWaitProblems(
    before,
    [
      { name: 'a', status: 'offline' },
      { name: 'b', status: 'offline' },
    ],
    300,
  );
  equal(p.length, 2);
  match(p[0] as string, /registration a is offline after 300 s idle .* \(it was online before the wait\)/);
  match(p[1] as string, /registration c is no longer listed/);
  deepEqual(afterWaitProblems(before.slice(0, 1), [{ name: 'a', status: 'online' }], 300), []);
});

test('readHostState on Windows records requestsOverride instead of throwing when powercfg fails', async () => {
  const run: HostRun = async (argv) => {
    if (argv[0] === 'powershell') return { code: 0, stdout: '["\\\\A"]', stderr: '' };
    if (argv[0] === 'powercfg') return { code: 1, stdout: '', stderr: 'Access denied' };
    throw new Error(`unexpected ${argv.join(' ')}`);
  };
  const s = await readHostState(run, 'windows');
  equal(s.platform, 'windows');
  if (s.platform !== 'windows') return;
  deepEqual(s.tasks, ['\\A']);
  equal(s.requestsOverride.ok, false);
  match(s.requestsOverride.output, /powercfg \/requestsoverride exited 1: Access denied/);
  const thrown = await readRequestsOverride(async () => {
    throw new Error('spawn powercfg ENOENT');
  });
  deepEqual(thrown, { ok: false, output: 'powercfg /requestsoverride: spawn powercfg ENOENT' });
  deepEqual(await readRequestsOverride(async () => ({ code: 0, stdout: '[SERVICE]\n', stderr: '' })), {
    ok: true,
    output: '[SERVICE]\n',
  });
});
