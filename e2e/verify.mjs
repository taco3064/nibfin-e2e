import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (/\.(mjs|go|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}
for (const path of await sources('e2e')) {
  const text = await readFile(path, 'utf8');
  const lines = text.trimEnd().split('\n');
  if (lines.length > 1000 || lines.some(line => line.length > 90)) {
    throw new Error(`Source size limit exceeded: ${path}`);
  }
  if (!path.endsWith('.mjs')) continue;
  const check = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (check.status !== 0) process.exit(1);
}
const tests = spawnSync(process.execPath, ['--test', 'e2e/test/*.test.mjs'], {
  stdio: 'inherit',
});
process.exitCode = tests.status ?? 1;
