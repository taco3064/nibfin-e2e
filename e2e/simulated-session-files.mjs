import { open, rename, lstat, readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export async function saveSession(path, data) {
  const pending = `${path}.pending`;
  const file = await open(pending, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(data)}\n`);
    await file.sync();
  } finally { await file.close(); }
  await rename(pending, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function readSession(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) {
    throw new Error('SIM_SESSION_CORRUPT');
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

// Refuse symlinked recovery/deletion trees, including nested source inputs.
export async function checkSessionTree(root, count = { value: 0 }) {
  const stat = await lstat(root);
  if (++count.value > 10000 || stat.isSymbolicLink()) {
    throw new Error('SIM_SESSION_PATH_UNSAFE');
  }
  if (stat.isDirectory()) {
    for (const name of await readdir(root)) {
      await checkSessionTree(join(root, name), count);
    }
  } else if (!stat.isFile()) throw new Error('SIM_SESSION_PATH_UNSAFE');
}
