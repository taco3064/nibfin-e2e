import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCommand } from '../source-process.mjs';

const invoke = (script, options) => sourceCommand(process.execPath,
  ['--input-type=module', '-e', script], options);

test('source commands await completion and capture output without stdout leakage',
  async () => {
  const result = await invoke([
    "await new Promise(resolve => setTimeout(resolve, 20));",
    "console.log('result'); console.error('diagnostic');",
  ].join('\n'));
  assert.equal(result.stdout, 'result\n');
  assert.equal(result.stderr, 'diagnostic\n');
  await assert.rejects(invoke('process.exit(7)'), /SOURCE_COMMAND_FAILED/);
  await assert.rejects(sourceCommand('/nonexistent/nibfin-tool', []), /ENOENT/);
});

test('timeouts and excessive output fail after owned process cleanup', async () => {
  await assert.rejects(invoke('setInterval(() => {}, 1000)', { timeoutMs: 100 }),
    /SOURCE_COMMAND_TIMEOUT/);
  await assert.rejects(invoke("console.log('x'.repeat(10000))", { limit: 10 }),
    /SOURCE_COMMAND_OUTPUT_LIMIT/);
});

async function within(promise, message, timeoutMs = 4000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('timeout stops producer descendants before disposable directory removal',
  async () => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-process-test-'));
  let wrapper;
  let pid;
  let ready;
  let settled;
  let closed;
  const handshake = new Promise(resolve => { ready = resolve; });
  const completion = new Promise(resolve => { settled = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const descendant = [
    "const { writeSync } = require('node:fs');",
    "writeSync(3, 'handshake:' + process.pid + '\\n');",
    // Keep running even if the observer closes its end of the pipe.
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const producer = [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],`,
    "  { stdio: ['ignore', 'ignore', 'ignore', 3] });",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const script = [
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    // Test-only wiring gives the producer a dedicated inherited observation pipe.
    // Preserve all production spawn options and process-group cleanup behavior.
    'const originalSpawn = childProcess.spawn;',
    'childProcess.spawn = (file, args, options) => originalSpawn(file, args, {',
    '  ...options, stdio: [...options.stdio, 1],',
    '});',
    'syncBuiltinESMExports();',
    `const { sourceCommand } = await import(${JSON.stringify(
      new URL('../source-process.mjs', import.meta.url).href,
    )});`,
    'try {',
    `  await sourceCommand(process.execPath, ['--input-type=module', '-e',`,
    `    ${JSON.stringify(producer)}], { timeoutMs: 5000 });`,
    "  console.log('unexpected success');",
    "} catch (error) { console.log(String(error)); }",
  ].join('\n');
  try {
    wrapper = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
    });
    let received = '';
    wrapper.stdout.setEncoding('utf8');
    wrapper.stdout.on('data', chunk => {
      received += chunk;
      const match = received.match(/handshake:([0-9]+)\n/);
      if (match) ready(Number(match[1]));
      if (received.includes('SOURCE_COMMAND_TIMEOUT')) settled();
    });
    wrapper.stdout.once('end', closed);
    pid = await within(handshake, 'Producer descendant did not answer handshake');
    assert.equal(wrapper.stdout.readableEnded, false);
    await within(completion, 'Timeout did not settle', 7000);
    // The wrapper exits after reporting completion. Only the actual grandchild
    // can retain the inherited writer, so EOF proves it released the pipe too.
    await within(disconnected, 'Producer descendant pipe still open');
  } finally {
    // Kill a surviving negative-control fixture before closing its observation
    // channel. Teardown must never be able to satisfy the assertion above.
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (wrapper) {
      const exited = new Promise(resolve => wrapper.once('close', resolve));
      if (wrapper.exitCode === null) wrapper.kill('SIGKILL');
      if (wrapper.exitCode === null) await exited;
      wrapper.stdout.destroy();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('failed commands retain bounded diagnostics for native assertion failures',
  async () => {
    await assert.rejects(invoke("console.log('assertion failed'); process.exit(1)"),
      error => error.stdout === 'assertion failed\n' && error.stderr === '');
  });

test('owned command cancellation settles before cleanup', async () => {
  const abort = new AbortController();
  const pending = invoke('setInterval(() => {}, 1000)', { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /SOURCE_COMMAND_ABORTED/);
});
