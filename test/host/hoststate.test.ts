import { deepEqual, equal, match, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import {
  CRONTAB_PROBE,
  PERIODIC_COMMANDS,
  hasUserManager,
  hostPeriodicRun,
  parseCronUnits,
  parseCrontab,
  parseCrontabProbe,
  parseTask,
  parseTimerList,
  readCron,
  readPeriodic,
  readTask,
  readVmPeriodic,
  vmCommand,
} from '../../src/host/hoststate.ts';
import type { HostRun, PeriodicCommand, PeriodicRun } from '../../src/host/hoststate.ts';
import type { ExecResult } from '../../src/host/exec.ts';

const r = (code: number, stdout = '', stderr = ''): ExecResult => ({ code, stdout, stderr });
const PRESENT = r(0, 'nibfin-e2e:crontab=present\n');
const ABSENT = r(0, 'nibfin-e2e:crontab=absent\n');
const SERVICES = 'dbus.service static -\nssh.service enabled enabled\n';

test('parseTimerList: the timer of each line, with or without dates, n/a and transient timers', () => {
  const out = [
    'Fri 2026-11-27 00:00:00 UTC 5h left Thu 2026-11-26 00:00:00 UTC 18h ago logrotate.timer logrotate.service',
    'n/a n/a n/a n/a run-u12.timer run-u12.service',
    '-    -    -    -  fstrim.timer fstrim.service',
    'n/a n/a n/a n/a run-u12.timer run-u12.service',
    '',
  ].join('\n');
  deepEqual(parseTimerList(out), ['fstrim.timer', 'logrotate.timer', 'run-u12.timer']);
  deepEqual(parseTimerList(''), []);
  throws(
    () => parseTimerList('Failed to connect to bus: No medium found'),
    /unreadable timer line: Failed to connect to bus/,
  );
});

test('parseCrontabProbe: one marker on exit 0; any exit code, no marker, an unknown line or both markers throw', () => {
  equal(parseCrontabProbe(PRESENT), 'present');
  equal(parseCrontabProbe(r(0, '  nibfin-e2e:crontab=absent  \r\n')), 'absent');
  for (const code of [127, 125, 255])
    throws(
      () => parseCrontabProbe(r(code, 'nibfin-e2e:crontab=absent\n', 'boom')),
      new RegExp(`the crontab probe exited ${code}`),
    );
  throws(() => parseCrontabProbe(r(0, '')), /printed no single marker: no output/);
  throws(() => parseCrontabProbe(r(0, 'hello\n')), /printed no single marker: hello/);
  throws(() => parseCrontabProbe(r(0, 'nibfin-e2e:crontab=present\nnibfin-e2e:crontab=absent\n')), /no single marker/);
});

test('parseCrontab: entries without comments and blanks; "no crontab for" is empty; other failures and 127 throw', () => {
  deepEqual(parseCrontab(r(0, '# m h dom mon dow command\n\nMAILTO=""\n*/5 * * * * /bin/true\n')), [
    'MAILTO=""',
    '*/5 * * * * /bin/true',
  ]);
  deepEqual(parseCrontab(r(1, '', 'no crontab for runner\n')), []);
  throws(
    () => parseCrontab(r(1, '', 'crontab: cannot open /var/spool/cron: Permission denied')),
    /crontab -l exited 1: crontab: cannot open/,
  );
  throws(() => parseCrontab(r(127, '', 'spawn crontab ENOENT')), /crontab -l exited 127/);
});

test('parseCronUnits: the cron units among the service unit files; a failed or empty list throws', () => {
  deepEqual(parseCronUnits(r(0, SERVICES)), []);
  deepEqual(parseCronUnits(r(0, SERVICES + 'cron.service enabled enabled\n')), ['cron.service']);
  deepEqual(parseCronUnits(r(0, 'crond.service enabled enabled\n' + SERVICES)), ['crond.service']);
  throws(
    () => parseCronUnits(r(1, '', 'Failed to list unit files')),
    /systemctl list-unit-files --no-legend --plain --type=service exited 1: Failed to list unit files/,
  );
  throws(() => parseCronUnits(r(0, '')), /read no service unit files/);
});

/** A runner over fixed answers, recording each command. */
function answers(by: Partial<Record<keyof typeof PERIODIC_COMMANDS, ExecResult>>) {
  const seen: PeriodicCommand[] = [];
  const run: PeriodicRun = async (command) => {
    seen.push(command);
    const key = (Object.keys(PERIODIC_COMMANDS) as (keyof typeof PERIODIC_COMMANDS)[]).find(
      (k) => PERIODIC_COMMANDS[k] === command,
    );
    return (key && by[key]) ?? r(0);
  };
  return { run, seen };
}

test('cron: absent with no cron unit is unavailable with evidence; a cron unit or a failed list throws', async () => {
  const none = await readCron(answers({ probe: ABSENT, cronUnits: r(0, SERVICES) }).run);
  deepEqual(none.available, false);
  match(
    !none.available ? none.evidence : '',
    /nibfin-e2e:crontab=absent.*no cron.service\/crond.service among 2 service unit files/,
  );
  await rejects(
    readCron(answers({ probe: ABSENT, cronUnits: r(0, SERVICES + 'crond.service enabled enabled\n') }).run),
    /no crontab command, but the service unit files list crond.service/,
  );
  await rejects(
    readCron(answers({ probe: ABSENT, cronUnits: r(1, '', 'no units') }).run),
    /--type=service exited 1: no units/,
  );
  deepEqual(await readCron(answers({ probe: PRESENT, crontab: r(0, '@hourly x\n') }).run), {
    available: true,
    entries: ['@hourly x'],
  });
});

test('readPeriodic: no manager is allowed only with noManagerOk and cron is still read; after absent no crontab -l runs', async () => {
  const offline = answers({
    units: r(1, '', 'Failed to connect to bus'),
    probe: PRESENT,
    crontab: r(1, '', 'no crontab for runner'),
  });
  deepEqual(await readPeriodic(offline.run, { noManagerOk: true }), {
    units: [],
    timers: [],
    cron: { available: true, entries: [] },
    manager: false,
  });
  deepEqual(offline.seen, [PERIODIC_COMMANDS.units, PERIODIC_COMMANDS.probe, PERIODIC_COMMANDS.crontab]);
  await rejects(
    readPeriodic(answers({ units: r(1, '', 'Failed to connect to bus') }).run, { noManagerOk: false }),
    /systemctl --user list-unit-files --no-legend --plain exited 1: Failed to connect to bus/,
  );
  await rejects(
    readPeriodic(answers({ units: r(0, 'a.service enabled enabled\n'), timers: r(1, '', 'bad') }).run, {
      noManagerOk: true,
    }),
    /list-timers --all --no-legend --plain exited 1: bad/,
  );

  const absent = answers({
    units: r(0, 'a.timer static -\n'),
    timers: r(0, 'n/a n/a n/a n/a a.timer a.service\n'),
    probe: ABSENT,
    cronUnits: r(0, SERVICES),
  });
  const got = await readPeriodic(absent.run, { noManagerOk: false });
  deepEqual(
    [got.units, got.timers, got.cron.available, got.manager],
    [[{ name: 'a.timer', state: 'static' }], ['a.timer'], false, true],
  );
  equal(absent.seen.includes(PERIODIC_COMMANDS.crontab), false);
  deepEqual(PERIODIC_COMMANDS.cronUnits.words, [
    'systemctl',
    'list-unit-files',
    '--no-legend',
    '--plain',
    '--type=service',
  ]);
});

test('hostPeriodicRun: words run as argv and the probe as sh -c, with the runtime directory', async () => {
  const calls: { argv: string[]; env?: Record<string, string> }[] = [];
  const run: HostRun = async (argv, env) => (calls.push({ argv, env }), r(0));
  const host = hostPeriodicRun(run, '/run/user/1001');
  await host(PERIODIC_COMMANDS.probe);
  await host(PERIODIC_COMMANDS.timers);
  deepEqual(calls, [
    { argv: ['sh', '-c', CRONTAB_PROBE], env: { XDG_RUNTIME_DIR: '/run/user/1001' } },
    {
      argv: ['systemctl', '--user', 'list-timers', '--all', '--no-legend', '--plain'],
      env: { XDG_RUNTIME_DIR: '/run/user/1001' },
    },
  ]);
});

test('hasUserManager: a runtime directory with systemd/private or bus', () => {
  equal(
    hasUserManager(undefined, () => true),
    false,
  );
  equal(
    hasUserManager('/r', () => false),
    false,
  );
  equal(
    hasUserManager('/r', (p) => p === '/r/bus'),
    true,
  );
  equal(
    hasUserManager('/r', (p) => p === '/r/systemd/private'),
    true,
  );
});

test('vmCommand: fixed words become one string, the probe stays as is, an unsafe word throws', () => {
  equal(vmCommand(PERIODIC_COMMANDS.cronUnits), 'systemctl list-unit-files --no-legend --plain --type=service');
  equal(vmCommand(PERIODIC_COMMANDS.probe), CRONTAB_PROBE);
  for (const w of ['a b', 'a;b', '$HOME', "it's", '"x"'])
    throws(() => vmCommand({ words: ['echo', w] }), /is not a shell-safe word/);
});

/** A `podman machine ssh` runner that answers by the remote command string. */
function vm(answer: (command: string) => ExecResult | undefined) {
  const calls: string[][] = [];
  const run: HostRun = async (argv) => (calls.push(argv), answer(argv.at(-1) ?? '') ?? r(0));
  return { run, calls };
}

test('readVmPeriodic: every read is podman machine ssh podman-machine-default <one string>; cron absent in the VM reads as unavailable', async () => {
  const { run, calls } = vm((c) => {
    if (c.startsWith('systemctl --user list-unit-files')) return r(0, 'nibfin-runner-1.service enabled enabled\n');
    if (c === CRONTAB_PROBE) return ABSENT;
    if (c.startsWith('systemctl list-unit-files')) return r(0, SERVICES);
    return undefined;
  });
  const got = await readVmPeriodic(run);
  deepEqual([got.manager, got.timers, got.cron.available], [true, [], false]);
  for (const argv of calls) {
    equal(argv.length, 5);
    deepEqual(argv.slice(0, 4), ['podman', 'machine', 'ssh', 'podman-machine-default']);
  }
  const probe = calls.find((a) => a[4] === CRONTAB_PROBE);
  equal(probe !== undefined && !probe.includes('sh') && !probe.includes('-c'), true);
  equal(
    calls.some((a) => a[4] === 'crontab -l'),
    false,
  );
});

test('readVmPeriodic: podman and ssh failures and a probe that cannot run throw', async () => {
  for (const code of [125, 255]) {
    const { run } = vm((c) =>
      c.includes('list-timers')
        ? r(code, '', 'vm "podman-machine-default" is not running')
        : c.includes('list-unit-files')
          ? r(0, 'a.service enabled enabled\n')
          : undefined,
    );
    await rejects(
      readVmPeriodic(run),
      new RegExp(`list-timers --all --no-legend --plain exited ${code}: vm "podman-machine-default" is not running`),
    );
  }
  const { run } = vm((c) =>
    c === CRONTAB_PROBE
      ? r(127, '', 'sh: not found')
      : c.includes('list-unit-files')
        ? r(0, 'a.service enabled enabled\n')
        : undefined,
  );
  await rejects(readVmPeriodic(run), /the crontab probe exited 127: sh: not found/);
});

test('readTask: repetitions present, null and missing; the name goes only through the environment', async () => {
  deepEqual(
    parseTask({
      actions: [],
      triggers: ['MSFT_TaskLogonTrigger', 'MSFT_TaskEventTrigger'],
      repetitions: ['PT5M', null],
    }).repetitions,
    ['PT5M', ''],
  );
  deepEqual(parseTask({ actions: [], triggers: ['MSFT_TaskLogonTrigger'] }).repetitions, []);
  let seen: { argv: string[]; env?: Record<string, string> } | undefined;
  const run: HostRun = async (argv, env) => (
    (seen = { argv, env }),
    r(
      0,
      '{"actions":[{"execute":"podman.exe","arguments":"machine start"}],"triggers":["MSFT_TaskLogonTrigger"],"repetitions":[""]}',
    )
  );
  deepEqual(await readTask(run, '\\Nibfin\\start'), {
    actions: [{ execute: 'podman.exe', arguments: 'machine start' }],
    triggers: ['MSFT_TaskLogonTrigger'],
    repetitions: [''],
  });
  deepEqual(seen?.env, { NIBFIN_E2E_TASK_PATH: '\\Nibfin\\', NIBFIN_E2E_TASK_NAME: 'start' });
  match(seen?.argv.at(-1) ?? '', /Repetition\.Interval/);
  equal(seen?.argv.join(' ').includes('Nibfin\\start'), false);
});
