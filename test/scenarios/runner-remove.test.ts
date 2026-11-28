import { deepEqual, doesNotMatch, equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecResult } from '../../src/host/exec.ts';
import type { CoreLimit } from '../../src/host/ratelimit.ts';
import { Check, tail } from '../../scenarios/lib/check.ts';
import type { StartTaskRecord, TaskSeen } from '../../scenarios/lib/github.ts';
import {
  noStartTaskReason,
  notReachedEntry,
  removeOutcome,
  removeStep,
  startTasksToCheck,
} from '../../scenarios/management/runner-remove.ts';
import type { RemoveDeps } from '../../scenarios/management/runner-remove.ts';

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

const RESET = Date.UTC(2026, 10, 28, 18, 0, 0);
const res = (code: number, stdout = '', stderr = ''): ExecResult => ({ code, stdout, stderr });
const LIMITED = res(1, '', 'GitHub GET /repos/o/exec/actions/runners failed after 3 retries: API rate limit exceeded for user');

/** Deps whose `ghNibfin` answers `results` in turn and whose limit reads answer `limits` in turn. */
function deps(results: ExecResult[], limits: (CoreLimit | Error)[] = [], waitedMs = 0) {
  const calls: string[] = [];
  const d: RemoveDeps = {
    ghNibfin: async (args) => (calls.push(`gh nibfin ${args.join(' ')}`), results.shift() ?? res(0)),
    readLimit: async () => {
      calls.push('read limit');
      const l = limits.shift() ?? new Error('no limit');
      if (l instanceof Error) throw l;
      return l;
    },
    waitForLimit: async () => (calls.push('wait for limit'), { waitedMs }),
    sleep: async (ms) => void calls.push(`sleep ${ms}`),
    log: (l) => void calls.push(`log ${l}`),
  };
  return { d, calls };
}
const empty = { limit: 5000, remaining: 0, resetAt: RESET };
const room = { limit: 5000, remaining: 4200, resetAt: RESET };
const COUNT = ['runner', 'remove', 'claude', '--count', '2', '--yes'];
const ALL = ['runner', 'remove', 'claude', '--delete-login', '--yes'];
const ALL_LEFT = ['read-back 0 (R5.32)', 'registrations (R5.31)', 'volume (R6.23)', 'start task (R5.16)', 'init (R5.36)'];

test('removeStep: a rate-limited --count remove is not rerun and names the limit read', async () => {
  const { d, calls } = deps([LIMITED], [empty]);
  const r = await removeStep(d, COUNT, false);
  ok('rateLimited' in r);
  deepEqual(calls, ['gh nibfin runner remove claude --count 2 --yes', 'read limit']);
  const c = new Check();
  const entry = notReachedEntry('runner remove claude --count 2 --yes', r, ['read-back 1 (R5.32)', 'idle first (R5.32)']);
  const o = removeOutcome(c, [entry], 'unused');
  equal(o.status, 'failed');
  match(o.reason, /^precondition not reached: runner remove claude --count 2 --yes failed under a GitHub rate limit, exiting 1: /);
  match(o.reason, /API rate limit exceeded for user/);
  match(o.reason, /limit read after it: 0 of 5000 core REST calls left, resetting at 2026-11-28T18:00:00\.000Z/);
  match(o.reason, /not reached: read-back 1 \(R5\.32\), idle first \(R5\.32\)$/);
  doesNotMatch(o.reason, /\bR5\.3[12]:/);
});

test('removeStep: no rate-limit text but no core calls left still counts as rate-limited', async () => {
  const r = await removeStep(deps([res(1, '', 'boom')], [empty]).d, COUNT, false);
  ok('rateLimited' in r);
});

test('removeStep: a rate-limited remove-all is rerun once after the wait and its pass lets the checks go on', async () => {
  const { d, calls } = deps([LIMITED, res(0, 'remaining: 0\n')], [empty], 300_000);
  const r = await removeStep(d, ALL, true);
  ok('ok' in r);
  equal(r.ok.stdout, 'remaining: 0\n');
  equal(r.retried?.result, LIMITED);
  deepEqual(calls, [
    'gh nibfin runner remove claude --delete-login --yes',
    'read limit',
    'log gh nibfin runner remove claude --delete-login --yes failed under a GitHub rate limit; waiting for the limit, then running it once more',
    'wait for limit',
    'gh nibfin runner remove claude --delete-login --yes',
  ]);
});

test('removeStep: with core room left (a secondary limit) the rerun waits one minute first', async () => {
  const { d, calls } = deps([LIMITED, res(0)], [room], 0);
  ok('ok' in (await removeStep(d, ALL, true)));
  ok(calls.includes('sleep 60000'));
  ok(calls.indexOf('sleep 60000') < calls.lastIndexOf('gh nibfin runner remove claude --delete-login --yes'));
});

test('removeStep: a rerun that is still rate-limited gives one not-reached entry and no rule problem', async () => {
  const { d } = deps([LIMITED, LIMITED], [empty, new Error('GitHub GET /rate_limit returned 500: Server Error')], 1000);
  const r = await removeStep(d, ALL, true);
  ok('rateLimited' in r);
  const o = removeOutcome(new Check(), [notReachedEntry('runner remove claude --delete-login --yes', r, ALL_LEFT)], 'unused');
  match(o.reason, /^precondition not reached: runner remove claude --delete-login --yes failed under a GitHub rate limit \(on its rerun after a rate-limited try\)/);
  match(o.reason, /the limit could not be read \(GitHub GET \/rate_limit returned 500: Server Error\)/);
  doesNotMatch(o.reason, /\bR(5\.31|5\.32|6\.23|5\.16|5\.36):/);
  match(o.reason, /read-back 0 \(R5\.32\), registrations \(R5\.31\), volume \(R6\.23\), start task \(R5\.16\), init \(R5\.36\)$/);
});

test('removeStep: a failed remove with room left is not rerun: one R5.31 problem plus one not-reached entry', async () => {
  const { d, calls } = deps([res(1, '', 'podman: no such container')], [room]);
  const r = await removeStep(d, ALL, true);
  ok('failed' in r);
  equal(calls.filter((x) => x.startsWith('gh nibfin')).length, 1);
  const c = new Check();
  c.fail('R5.31', `runner remove claude --delete-login --yes exited 1: ${tail(r.failed.result)}`);
  const o = removeOutcome(c, [notReachedEntry('runner remove claude --delete-login --yes', r, ALL_LEFT)], 'unused');
  equal(o.status, 'failed');
  match(o.reason, /^R5\.31: runner remove claude --delete-login --yes exited 1: podman: no such container; precondition not reached: /);
  match(o.reason, /failed while the limit had room, exiting 1 \(the R5\.31 failure\); limit read after it: 4200 of 5000/);
  equal(o.reason.match(/\bR5\.31:/g)?.length, 1);
  doesNotMatch(o.reason, /\bR(5\.32|6\.23|5\.16|5\.36):/);
});

test('removeOutcome: with both removes passing the outcome is as Check gives it', async () => {
  const r = await removeStep(deps([res(0, 'remaining: 1\n')]).d, COUNT, false);
  deepEqual(r, { ok: res(0, 'remaining: 1\n') });
  deepEqual(removeOutcome(new Check(), [], 'all good'), { status: 'passed', reason: 'all good' });
  const c = new Check();
  c.fail('R6.23', 'the login volume still exists');
  deepEqual(removeOutcome(c, [], 'all good'), { status: 'failed', reason: 'R6.23: the login volume still exists' });
});
