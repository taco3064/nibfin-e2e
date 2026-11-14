import { mkdir, open, readFile, rename, rm, realpath } from 'node:fs/promises';
import { resolve, join, relative, dirname, basename, isAbsolute } from 'node:path';

async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

// This directory is protected-runner recovery state, never a worker directory.
// The caller owns its lifetime. No credential or provider response is stored here.
export async function fixtureInventory(directory, definition, actor, workerRoot) {
  const root = await canonical(resolve(directory));
  if (!Number.isSafeInteger(actor) || actor <= 0 || !workerRoot) {
    throw new Error('Actor and disposable worker root required');
  }
  const worker = await canonical(resolve(workerRoot));
  const within = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  if (within(worker, root) || within(root, worker)) {
    throw new Error('Inventory and worker roots must be disjoint');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${definition.owner}.json`);
  const lockPath = `${path}.lock`;
  return {
    path,
    async exclusive(action) {
      // Never break a stale lock automatically: the previous owner may still run.
      const lock = await open(lockPath, 'wx', 0o600);
      let state;
      try {
        try { state = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          state = { version: 1, definition, actor, resources: [] };
        }
        if (state.version !== 1 || state.actor !== actor ||
            JSON.stringify(state.definition) !== JSON.stringify(definition) ||
            !Array.isArray(state.resources)) throw new Error('Inventory mismatch');
        const save = async () => {
          const pending = `${path}.pending`;
          const file = await open(pending, 'w', 0o600);
          try {
            await file.writeFile(JSON.stringify(state, null, 2) + '\n');
            await file.sync();
          } finally { await file.close(); }
          await rename(pending, path);
        };
        await save();
        return await action(state, save);
      } finally {
        await lock.close();
        await rm(lockPath);
      }
    },
  };
}
