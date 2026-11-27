import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { findPodman, machineReport, podmanDirs, startPodmanMachine } from '../../src/host/podman.ts';
import type { ExecResult } from '../../src/host/exec.ts';
import { fakeExec } from './fakes.ts';

const machine = 'C:\\Program Files\\Podman';
const perUser = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\Podman';
const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local' };
const log = 'C:\\work\\.e2e-work\\podman-msi.log';

test('podmanDirs returns the machine-wide and per-user folders the pinned MSI installs to', () => {
  deepEqual(podmanDirs(env), [machine, perUser]);
});

test('podmanDirs reads ProgramFiles and LOCALAPPDATA case-insensitively', () => {
  deepEqual(podmanDirs({ PROGRAMFILES: 'C:\\Program Files', LocalAppData: 'C:\\Users\\runneradmin\\AppData\\Local' }), [machine, perUser]);
});

test('podmanDirs leaves out a folder whose variable is not set', () => {
  deepEqual(podmanDirs({ ProgramFiles: 'C:\\Program Files' }), [machine]);
  deepEqual(podmanDirs({ LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local' }), [perUser]);
  deepEqual(podmanDirs({}), []);
});

test('findPodman returns the folder that holds podman.exe in either scope', () => {
  deepEqual(findPodman(env, log, (p) => p === `${perUser}\\podman.exe`), [perUser]);
  deepEqual(findPodman(env, log, (p) => p === `${machine}\\podman.exe`), [machine]);
});

test('findPodman names every folder searched and the MSI log when podman.exe is missing', () => {
  throws(() => findPodman(env, log, () => false), (e: Error) => {
    deepEqual(e.message, `podman.exe not found after install in ${machine} or ${perUser}; see the MSI log ${log}`);
    return true;
  });
});

const RUNNING = 'Error: unable to start "podman-machine-default": already running';

test('startPodmanMachine accepts only Podman v6.2.1\'s already-running refusal, with one start call each', async () => {
  const cases: [Partial<ExecResult>, number, boolean][] = [
    [{}, 0, false],
    [{ code: 125, stderr: RUNNING }, 0, true],
    [{ code: 125, stderr: `${RUNNING}\r\n` }, 0, true],
    [{ code: 125, stderr: 'Error: machine is broken' }, 125, false],
    [{ code: 1, stderr: RUNNING }, 1, false],
    [{ code: 125, stderr: `${RUNNING} and broken` }, 125, false],
  ];
  for (const [answer, code, alreadyRunning] of cases) {
    const { exec, calls } = fakeExec(() => answer);
    const r = await startPodmanMachine(exec);
    deepEqual([r.code, r.alreadyRunning, r.stderr], [code, alreadyRunning, answer.stderr ?? '']);
    deepEqual(calls.map((c) => c.argv), [['podman', 'machine', 'start']]);
  }
});

test('machineReport names the state podman machine list shows and says initialised only after init', async () => {
  const list = (stdout: string) => fakeExec(() => ({ stdout })).exec;
  equal(await machineReport(list('[{"Name":"podman-machine-default","Running":false,"Starting":false}]'), true), 'podman machine initialised; podman-machine-default: stopped');
  equal(await machineReport(list('[{"Name":"podman-machine-default","Running":true}]'), false), 'podman machine already existed; podman-machine-default: running');
  equal(await machineReport(list('[{"Name":"m","Running":false,"Starting":true}]'), true), 'podman machine initialised; m: starting');
  equal(await machineReport(list('[{"Name":"m"}]'), true), 'podman machine initialised; m: state unknown');
  equal(await machineReport(list(''), true), 'podman machine initialised; podman machine list shows no machine');
  const failed = fakeExec(() => ({ code: 125, stderr: 'Error: no wsl' }));
  await rejects(machineReport(failed.exec, true), /podman machine list exited 125: Error: no wsl/);
  deepEqual(failed.calls.map((c) => c.argv), [['podman', 'machine', 'list', '--format', 'json']]);
});
