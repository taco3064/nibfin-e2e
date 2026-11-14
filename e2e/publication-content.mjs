import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceCommand } from './source-process.mjs';
import { sourceEnvironment } from './source-checkout.mjs';
import { producerFile } from './source-producers.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gitHash = (type, bytes) => createHash('sha1')
  .update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

async function assets(root) {
  const result = [];
  for (const name of (await readdir(root)).sort()) {
    const bytes = await readFile(await producerFile(root, name));
    result.push({ name, content: bytes.toString('base64'), sha256: digest(bytes) });
  }
  return result;
}

// Only called inside the successful gate, before its source owner disposes.
export async function capturePublication(
  { handoff, prepared, staged }, command = sourceCommand,
) {
  const repositories = [];
  for (const source of handoff.sources) {
    const row = { ...source, target: source.commit, objects: [], assets: [] };
    if (source.id === 'core') row.assets = await assets(staged.coreDirectory);
    if (source.id === 'cli') {
      row.assets = await assets(join(prepared.sources.cli.checkout, 'dist'));
    }
    if (source.id === 'action') {
      const checkout = prepared.sources.action.checkout;
      const result = await command('git', ['ls-tree', '-z', source.commit], {
        cwd: checkout, env: sourceEnvironment(prepared.root),
      });
      const entries = result.stdout.split('\0').filter(Boolean).map(line => {
        const match = /^(\d+) (blob|tree) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
        if (!match) throw new Error('CONTENT: invalid source tree');
        return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
      });
      for (const path of ['package.json', 'package-lock.json']) {
        const bytes = await readFile(await producerFile(checkout, path));
        const sha = gitHash('blob', bytes);
        row.objects.push({ kind: 'blob', sha, content: bytes.toString('base64') });
        const entry = entries.find(entry => entry.path === path);
        if (!entry || entry.type !== 'blob') throw new Error('CONTENT: metadata');
        entry.sha = sha;
      }
      const treeBytes = Buffer.concat(entries.map(entry => Buffer.concat([
        Buffer.from(`${entry.mode.replace(/^0/, '')} ${entry.path}\0`),
        Buffer.from(entry.sha, 'hex'),
      ])));
      const tree = gitHash('tree', treeBytes);
      row.objects.push({ kind: 'tree', sha: tree, entries });
      const identity = 'Nibfin Release <release@nibfin.invalid> 0 +0000';
      const message = `Release ${handoff.version}`;
      const bytes = Buffer.from(`tree ${tree}\nparent ${source.commit}\n` +
        `author ${identity}\ncommitter ${identity}\n\n${message}\n`);
      row.target = gitHash('commit', bytes);
      row.objects.push({ kind: 'commit', sha: row.target, tree,
        parent: source.commit, message: message + '\n' });
    }
    repositories.push(row);
  }
  return { handoff, repositories };
}
