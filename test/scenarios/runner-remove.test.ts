import { deepEqual, doesNotMatch, match } from 'node:assert/strict';
import { test } from 'node:test';
import type { StartTaskRecord, TaskSeen } from '../../scenarios/lib/github.ts';
import { noStartTaskReason, startTasksToCheck } from '../../scenarios/management/runner-remove.ts';

const PODMAN = 'C:\\Program Files\\RedHat\\Podman\\podman.exe';
const start = (name: string): TaskSeen => ({
  name,
  actions: [{ execute: `"${PODMAN}"`, arguments: 'machine start' }],
  triggers: ['MSFT_TaskLogonTrigger'],
});
const other = (name: string, execute: string, args: string): TaskSeen => ({
  name,
  actions: [{ execute, arguments: args }],
  triggers: [],
});
const recorded = (task?: TaskSeen, tasks: TaskSeen[] = task ? [task] : []): StartTaskRecord =>
  task ? { tasks, task } : { tasks };

test('startTasksToCheck: the recorded task still present is checked, first, alongside another new start task', () => {
  const record = recorded(start('\\nibfin-podman'));
  deepEqual(startTasksToCheck({ record, present: ['\\nibfin-podman'], fresh: [start('\\nibfin-podman')] }), {
    tasks: ['\\nibfin-podman'],
  });
  deepEqual(
    startTasksToCheck({
      record,
      present: ['\\x', '\\nibfin-podman'],
      fresh: [start('\\x'), start('\\nibfin-podman')],
    }),
    { tasks: ['\\nibfin-podman', '\\x'] },
  );
});

test('startTasksToCheck: with no record, or only a read error, a new start task is found', () => {
  deepEqual(startTasksToCheck({ present: ['\\p'], fresh: [start('\\p')] }), { tasks: ['\\p'] });
  deepEqual(startTasksToCheck({ record: { tasks: [], error: 'boom' }, present: ['\\p'], fresh: [start('\\p')] }), {
    tasks: ['\\p'],
  });
});

test('startTasksToCheck: a new task that runs podman machine start through conhost --headless is checked', () => {
  const fresh = [
    other('\\Nibfin podman machine', 'conhost.exe', `--headless ${PODMAN} machine start podman-machine-default`),
  ];
  deepEqual(startTasksToCheck({ present: ['\\Nibfin podman machine'], fresh }), { tasks: ['\\Nibfin podman machine'] });
  const stop = [other('\\stop', 'conhost.exe', `--headless "${PODMAN}" machine stop`)];
  deepEqual(startTasksToCheck({ present: ['\\stop'], fresh: stop }), { missing: 'none' });
});

test('startTasksToCheck: a new non-podman task is not taken as the start task', () => {
  const fresh = [
    other('\\a', 'C:\\x.exe', 'machine start'),
    other('\\b', PODMAN, 'machine stop'),
    { name: '\\c', error: 'access denied' },
  ];
  deepEqual(startTasksToCheck({ present: ['\\a', '\\b', '\\c'], fresh }), { missing: 'none' });
  deepEqual(startTasksToCheck({ record: recorded(), present: ['\\a'], fresh }), { missing: 'unrecorded' });
});

test('noStartTaskReason: the recorded task gone at the start is named, with what an earlier removal may have done', () => {
  const record = recorded(start('\\nibfin-podman'));
  const found = startTasksToCheck({ record, present: [], fresh: [] });
  deepEqual(found, { missing: 'gone' });
  const reason = noStartTaskReason({ record, missing: 'gone', fresh: [], older: [] });
  match(reason, /^runner add's scheduled task that runs podman machine start cannot be checked for removal: /);
  match(reason, /the recorded task \\nibfin-podman \(actions: ".*podman\.exe" machine start\) was gone/);
  match(reason, /an earlier Runner removal may have removed it — file a new request/);
  match(reason, /new since before runner add at runner-remove start: none$/);
});

test('noStartTaskReason: with no start task anywhere, it lists the new tasks and their actions, or the read error', () => {
  const fresh = [other('\\a', 'C:\\x.exe', 'machine start'), { name: '\\c', error: 'access denied' }];
  const unrecorded = noStartTaskReason({
    record: recorded(undefined, [other('\\u', 'cmd.exe', '/c echo')]),
    missing: 'unrecorded',
    fresh,
    older: [],
  });
  match(unrecorded, /the record right after runner add found no such task \(new tasks then: \\u \(actions: cmd\.exe \/c echo\)\)/);
  match(
    unrecorded,
    /new since before runner add at runner-remove start: \\a \(actions: C:\\x\.exe machine start\), \\c \(read error: access denied\)$/,
  );
  const failed = noStartTaskReason({ record: { tasks: [], error: 'powershell exited 1' }, missing: 'none', fresh: [], older: [] });
  match(failed, /could not read the scheduled tasks: powershell exited 1/);
  match(noStartTaskReason({ missing: 'none', fresh: [], older: [] }), /left no record of the tasks right after runner add/);
});

test('noStartTaskReason: a start task that existed before runner add is named as not new', () => {
  const reason = noStartTaskReason({
    record: recorded(),
    missing: 'unrecorded',
    fresh: [],
    older: [start('\\podman-start'), other('\\podman-update', PODMAN, 'machine stop')],
  });
  match(reason, /a start task \\podman-start \(actions: .*machine start\) is present but existed before runner add/);
  doesNotMatch(reason, /\\podman-update/);
});
