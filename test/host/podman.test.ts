import { deepEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { findPodman, podmanDirs } from '../../src/host/podman.ts';

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
