import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { execute } from '../execution.mjs';
import { scenarios } from '../registry.mjs';

// A controlled go executable keeps a child holding stdout and recreating its
// work directory. Parent command ownership must outlive worker termination.
test('worker timeout stops native descendants before removing their files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-cli-process-'));
  const previousPath = process.env.PATH;
  let pid;
  let pending;
  try {
    const checkout = join(root, 'fixture');
    const tools = join(root, 'tools');
    const executions = join(root, 'executions');
    await mkdir(join(checkout, 'internal/cli'), { recursive: true });
    await mkdir(tools);
    await mkdir(executions);
    const handshake = join(root, 'started.json');
    const descendant = [
      "const fs = require('node:fs');",
      'const directory = process.cwd();',
      'setInterval(() => fs.mkdirSync(directory, {recursive:true}), 10);',
      `fs.writeFileSync(${JSON.stringify(handshake + '.tmp')}, JSON.stringify({`,
      '  group:process.ppid, child:process.pid, cwd:directory,',
      '}));',
      `fs.renameSync(${JSON.stringify(handshake + '.tmp')},`,
      `  ${JSON.stringify(handshake)});`,
    ].join('\n');
    const script = [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],`,
      "  {stdio:'inherit'});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    await writeFile(join(tools, 'go'), script, { mode: 0o700 });
    process.env.PATH = `${tools}:${previousPath}`;
    // Advance only the supervisor's timer after observing native startup.
    // Real-time polling remains bounded even if the worker never starts.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const onboarding = scenarios.find(row => row.group === 'cli-onboarding');
    pending = execute({ ...onboarding, timeoutMs: 30000 }, {
      tempRoot: executions,
      sources: { cli: { checkout, output: { entry: join(tools, 'go') } } },
    });
    const deadline = Date.now() + 30000;
    let started;
    while (!started && Date.now() < deadline) {
      try { started = JSON.parse(await readFile(handshake, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!started) await delay(20);
    }
    // Always settle execution, including when the startup assertion fails.
    pid = started?.group;
    t.mock.timers.tick(30000);
    const actual = await pending;
    assert.ok(started, 'native command must start within the startup budget');
    assert.equal(actual.reason.code, 'TIMEOUT');
    assert.deepEqual(await readdir(executions), []);
    await delay(100);
    assert.deepEqual(await readdir(executions), []);
  } finally {
    if (pending) {
      t.mock.timers.tick(120000);
      await pending;
    }
    process.env.PATH = previousPath;
    if (pid) {
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});
