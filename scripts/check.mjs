import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'coverage'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Source symlink: ${path}`);
    if (entry.isDirectory()) {
      await check(path);
      continue;
    }
    if (!/\.(?:mjs|js|cjs|json|ya?ml)$/.test(path)) continue;
    const text = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    assert(lines.length <= 1000, `Source file limit: ${path}`);
    for (const [index, line] of lines.entries()) {
      assert([...line].length <= 90, `Source line limit: ${path}:${index + 1}`);
    }
    if (/\.(?:mjs|js|cjs)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], {
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Syntax check: ${path}`);
    }
  }
}

const version = (await readFile('.node-version', 'utf8')).trim();
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(process.versions.node, version, 'Use the pinned Node version');
assert.equal(pkg.engines.node, version, 'Runtime pins must agree');
await check('.');
console.log('Whole-file source limits, syntax and runtime pins checked.');
