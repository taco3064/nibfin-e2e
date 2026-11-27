import { deepEqual, equal, match, throws } from 'node:assert/strict';
import { test } from 'node:test';
import {
  machineState,
  parseProcesses,
  parseTaskRun,
  parseUnitShow,
  runningMachines,
  startTask,
  strandedConsoles,
  taskEnded,
  unitDetached,
} from '../../scenarios/management/podman-machine-detached.ts';
import type { Snapshot } from '../../scenarios/management/podman-machine-detached.ts';

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
const base: Snapshot = { self: 100, procs: [p(4, 0, 'System', at(0)), p(10, 4, 'explorer.exe', at(1)), p(50, 999, 'conhost.exe', at(1)), p(100, 10, 'powershell.exe', at(2)), p(101, 100, 'conhost.exe', at(2))] };

test('process snapshot: lenient parse, malformed input throws', () => {
  const s = parseProcesses(JSON.stringify({ self: 7, procs: [{ pid: 1, ppid: 0, name: 'a', created: at(1) }, { name: 'no pid' }, { pid: 'x' }, { pid: 2 }] }));
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
  deepEqual(flagged.map((x) => [x.pid, x.name]), [[200, 'conhost.exe'], [202, 'OpenConsole.exe'], [204, 'podman.exe']]);
  match(flagged[2]?.why ?? '', /podman\.exe still alive \(parent explorer\.exe\)/);
  // The pre-existing orphaned conhost (pid 50) and the earlier snapshot's own processes are not flagged.
  deepEqual(strandedConsoles(base, { ...base, self: 999 }), []);
});

test('start task: the task that runs podman machine start', () => {
  const d = (execute: string, args: string) => ({ actions: [{ execute, arguments: args }], triggers: [], repetitions: [] });
  const picked = startTask([
    { t: '\\Other\\x', d: d('C:\\x.exe', 'machine start') },
    { t: '\\Nibfin\\start', d: d('C:\\Program Files\\RedHat\\Podman\\podman.exe', 'machine start') },
  ]);
  equal(picked?.t, '\\Nibfin\\start');
  equal(startTask([{ t: '\\a', d: d('podman.exe', 'machine stop') }]), undefined);
});

test('podman machine inspect: the state, or a throw', () => {
  equal(machineState('[{"Name":"podman-machine-default","State":"running"}]'), 'running');
  throws(() => machineState('[]'), /no State/);
  throws(() => machineState('Error: no machine'));
});

test('user unit: active under user@<uid>.service and not in a session scope', () => {
  const show = (state: string, cg: string) => parseUnitShow(`ActiveState=${state}\nControlGroup=${cg}\n`);
  equal(unitDetached(show('active', '/user.slice/user-1001.slice/user@1001.service/app.slice/x.service'), 1001), undefined);
  match(unitDetached(show('active', '/user.slice/user-1001.slice/session-3.scope'), 1001) ?? '', /session-3\.scope, a login session/);
  match(unitDetached(show('inactive', '/user.slice/user-1001.slice/user@1001.service/app.slice/x.service'), 1001) ?? '', /is inactive/);
  match(unitDetached(show('active', '/user.slice/user-1002.slice/user@1002.service/app.slice/x.service'), 1001) ?? '', /not under user@1001\.service/);
  match(unitDetached({}, 1001) ?? '', /unknown state in no control group/);
});

test('podman machine list: running machine names; non-array throws', () => {
  deepEqual(runningMachines('[]'), []);
  deepEqual(runningMachines('[{"Name":"a","Running":false},{"Name":"b","Running":true}]'), ['b']);
  throws(() => runningMachines('{"Name":"a"}'), /not a JSON array/);
});
