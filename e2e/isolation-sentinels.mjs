import { randomUUID } from 'node:crypto';
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

// The protected caller supplies its owned disposable parent. No observed input
// selects a path. Tokens are capabilities and are never reconstructed from JSON.
export async function disposableSentinels(parent) {
  const root = await mkdtemp(join(parent, 'isolation-'));
  const owned = new Map();
  let closed = false;
  function entry(token) {
    if (closed || !owned.has(token)) throw new Error('Unowned sentinel');
    return owned.get(token);
  }
  return {
    reserve(run) {
      if (closed || typeof run !== 'string' || !run || run.length > 128) {
        throw new Error('Disposable run required');
      }
      if ([...owned.keys()].some(token => token.run === run)) {
        throw new Error('Disposable run already reserved');
      }
      const token = Object.freeze({ run, nonce: randomUUID() });
      owned.set(token, join(root, token.nonce));
      return token;
    },
    // Only authorized launchers receive this path, never ordinary worker input.
    target(token) { return entry(token); },
    async write(token) {
      await writeFile(entry(token), token.nonce, { flag: 'wx', mode: 0o600 });
    },
    async inspect(token) {
      const path = entry(token);
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
          constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== token.nonce.length) {
          return { ...token, state: 'unknown' };
        }
        const buffer = Buffer.alloc(token.nonce.length);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const present = bytesRead === buffer.length &&
          buffer.toString('utf8') === token.nonce;
        return { ...token, state: present ? 'present' : 'unknown' };
      } catch (error) {
        return { ...token, state: error.code === 'ENOENT' ? 'absent' : 'unknown' };
      } finally { await file?.close(); }
    },
    async cleanup() {
      if (closed) return { cleaned: true };
      await rm(root, { recursive: true, force: true });
      closed = true;
      owned.clear();
      return { cleaned: true };
    },
  };
}
