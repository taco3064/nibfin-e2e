import { deepEqual, equal, match, throws } from 'node:assert/strict';
import { test } from 'node:test';
import {
  machineState,
  parseProcesses,
  parseTaskRun,
  parseUnitShow,
  runningMachines,
  strandedConsoles,
  taskEnded,
  unitDetached,
} from '../../scenarios/management/podman-machine-detached.ts';
import type { Snapshot } from '../../scenarios/management/podman-machine-detached.ts';
import { startsMachine, startTask } from '../../scenarios/lib/start-task.ts';

const before = parseTaskRun('{"state":"Ready","lastRunTime":"2026-11-27T08:00:00.0000000+00:00","lastResult":0}');
const run = (state: string, lastRunTime: string, lastResult?: number) => ({ state, lastRunTime, lastResult });
const T2 = '2026-11-27T09:00:00.0000000+00:00';

test('task run: parsed and judged ended only after a new, final run', () => {
  deepEqual(before, { state: 'Ready', lastRunTime: '2026-11-27T08:00:00.0000000+00:00', lastResult: 0 });
  equal(taskEnded(run('Ready', T2, 0), before), true);
  equal(taskEnded(run('Ready', T2, 1), before), true);
  equal(taskEnded(run('Running', T2, 0), before), false);
  equal(taskEnded(run('Queued', T2, 0), before), false);
  equal(taskEnded(run('Ready', T2, 0x41301), before), false);
  equal(taskEnded(run('Ready', T2, 0x41303), before), false);
  equal(taskEnded(run('Ready', T2), before), false);
  equal(taskEnded(run('Ready', before.lastRunTime, 0), before), false);
  equal(parseTaskRun('{"state":"Ready","lastResult":"x"}').lastResult, undefined);
  throws(() => parseTaskRun('Get-ScheduledTaskInfo : not found'), /not JSON: Get-ScheduledTaskInfo/);
  throws(() => parseTaskRun('[1]'), /has no state/);
});

const p = (pid: number, ppid: number, name: string, created: string) => ({ pid, ppid, name, created });
const at = (m: number) => `2026-11-27T08:${String(m).padStart(2, '0')}:00.0000000+00:00`;
const base: Snapshot = {
  self: 100,
  procs: [
    p(4, 0, 'System', at(0)),
    p(10, 4, 'explorer.exe', at(1)),
    p(50, 999, 'conhost.exe', at(1)),
    p(100, 10, 'powershell.exe', at(2)),
    p(101, 100, 'conhost.exe', at(2)),
  ],
};

test('process snapshot: lenient parse, malformed input throws', () => {
  const s = parseProcesses(
    JSON.stringify({
      self: 7,
      procs: [{ pid: 1, ppid: 0, name: 'a', created: at(1) }, { name: 'no pid' }, { pid: 'x' }, { pid: 2 }],
    }),
  );
  deepEqual(s, { self: 7, procs: [p(1, 0, 'a', at(1)), p(2, -1, '', '')] });
  throws(() => parseProcesses('not json'), /not JSON/);
  throws(() => parseProcesses('{"self":1}'), /no procs array/);
});

test('stranded consoles: orphaned new consoles and new podman.exe are flagged', () => {
  const after: Snapshot = {
    self: 300,
    procs: [
      ...base.procs.filter((x) => x.pid !== 100 && x.pid !== 101),
      p(300, 10, 'powershell.exe', at(9)),
      p(301, 300, 'conhost.exe', at(9)), // the snapshot's own console
      p(200, 777, 'conhost.exe', at(5)), // opener gone
      p(201, 10, 'conhost.exe', at(5)), // opener alive
      p(202, 203, 'OpenConsole.exe', at(5)), // pid 203 reused by a later process
      p(203, 10, 'notepad.exe', at(7)),
      p(204, 10, 'podman.exe', at(6)),
    ],
  };
  const flagged = strandedConsoles(base, after);
  deepEqual(
    flagged.map((x) => [x.pid, x.name]),
    [
      [200, 'conhost.exe'],
      [202, 'OpenConsole.exe'],
      [204, 'podman.exe'],
    ],
  );
  match(flagged[2]?.why ?? '', /podman\.exe still alive \(parent explorer\.exe\)/);
  // The pre-existing orphaned conhost (pid 50) and the earlier snapshot's own processes are not flagged.
  deepEqual(strandedConsoles(base, { ...base, self: 999 }), []);
});

test('start task: the task that runs podman machine start', () => {
  const d = (execute: string, args: string) => ({
    actions: [{ execute, arguments: args }],
    triggers: [],
    repetitions: [],
  });
  const picked = startTask([
    { t: '\\Other\\x', d: d('C:\\x.exe', 'machine start') },
    { t: '\\Nibfin\\start', d: d('C:\\Program Files\\RedHat\\Podman\\podman.exe', 'machine start') },
  ]);
  equal(picked?.t, '\\Nibfin\\start');
  equal(startTask([{ t: '\\a', d: d('podman.exe', 'machine stop') }]), undefined);
  const conhost = startTask([
    { t: '\\Other\\x', d: d('conhost.exe', '--headless C:\\x.exe machine start') },
    {
      t: '\\Nibfin podman machine',
      d: d('conhost.exe', '--headless C:\\Program Files\\RedHat\\Podman\\podman.exe machine start podman-machine-default'),
    },
  ]);
  equal(conhost?.t, '\\Nibfin podman machine');
});

test('start task: podman run directly, quoted or not, with any path', () => {
  const ok = (execute: string, args = 'machine start') => equal(startsMachine({ execute, arguments: args }), true, execute);
  ok('podman');
  ok('podman.exe');
  ok('PODMAN.EXE');
  ok('C:\\Program Files\\RedHat\\Podman\\podman.exe');
  ok('"C:\\Program Files\\RedHat\\Podman\\podman.exe"');
  ok(' "C:\\Podman\\podman.exe" ');
  ok('/usr/bin/podman', 'machine start podman-machine-default');
});

test('start task: podman run through conhost --headless, quoted or not, with any path', () => {
  const ok = (execute: string, args: string) => equal(startsMachine({ execute, arguments: args }), true, `${execute} ${args}`);
  const podman = 'C:\\Program Files\\RedHat\\Podman\\podman.exe';
  for (const execute of ['conhost.exe', 'conhost', 'C:\\Windows\\System32\\conhost.exe', '"C:\\Windows\\System32\\conhost.exe"']) {
    ok(execute, `--headless ${podman} machine start podman-machine-default`);
    ok(execute, `--headless "${podman}" machine start podman-machine-default`);
  }
  ok('conhost.exe', '--headless podman.exe machine start');
  ok('conhost.exe', '--headless podman machine start');
  ok('conhost.exe', `--headless --width 80 "${podman}" machine start`);
  ok('conhost.exe', `--width 80 --headless ${podman} machine start`);
});

test('start task: other subcommands, other programs and conhost without --headless are not the start task', () => {
  const no = (execute: string, args: string) => equal(startsMachine({ execute, arguments: args }), false, `${execute} ${args}`);
  no('podman.exe', 'machine stop');
  no('C:\\Podman\\podman.exe', 'machine list');
  no('conhost.exe', '--headless podman.exe machine stop');
  no('conhost.exe', '--headless "C:\\Podman\\podman.exe" machine stop podman-machine-default');
  no('conhost.exe', 'C:\\Podman\\podman.exe machine start');
  no('conhost.exe', '--headlessly podman.exe machine start');
  no('conhost.exe', 'podman.exe machine start --headless');
  no('conhost.exe', '--headless C:\\x.exe machine start');
  no('conhost.exe', '--headless C:\\notpodman.exe machine start');
  no('C:\\x.exe', 'machine start');
  no('notpodman.exe', 'machine start');
  no('C:\\Tools\\notpodman.exe', 'machine start');
  no('cmd.exe', '/c podman.exe machine start');
  no('notconhost.exe', '--headless podman.exe machine start');
});

test('podman machine inspect: the state, or a throw', () => {
  equal(machineState('[{"Name":"podman-machine-default","State":"running"}]'), 'running');
  throws(() => machineState('[]'), /no State/);
  throws(() => machineState('Error: no machine'));
});

test('user unit: active under user@<uid>.service and not in a session scope', () => {
  const show = (state: string, cg: string) => parseUnitShow(`ActiveState=${state}\nControlGroup=${cg}\n`);
  equal(
    unitDetached(show('active', '/user.slice/user-1001.slice/user@1001.service/app.slice/x.service'), 1001),
    undefined,
  );
  match(
    unitDetached(show('active', '/user.slice/user-1001.slice/session-3.scope'), 1001) ?? '',
    /session-3\.scope, a login session/,
  );
  match(
    unitDetached(show('inactive', '/user.slice/user-1001.slice/user@1001.service/app.slice/x.service'), 1001) ?? '',
    /is inactive/,
  );
  match(
    unitDetached(show('active', '/user.slice/user-1002.slice/user@1002.service/app.slice/x.service'), 1001) ?? '',
    /not under user@1001\.service/,
  );
  match(unitDetached({}, 1001) ?? '', /unknown state in no control group/);
});

test('podman machine list: running machine names; non-array throws', () => {
  deepEqual(runningMachines('[]'), []);
  deepEqual(runningMachines('[{"Name":"a","Running":false},{"Name":"b","Running":true}]'), ['b']);
  throws(() => runningMachines('{"Name":"a"}'), /not a JSON array/);
});
