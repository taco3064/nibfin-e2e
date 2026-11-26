import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createStart } from '../../src/host/exec.ts';
import type { SpawnFn } from '../../src/host/exec.ts';

/** A child that ignores every signal and never closes unless told to. */
function stubborn() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  const signals: string[] = [];
  let unrefs = 0;
  Object.assign(child, io, { kill: (s: string) => (signals.push(s), true), unref: () => void unrefs++ });
  let seen: { cmd: string; args: string[]; env: Record<string, string | undefined> } | undefined;
  const spawnFn: SpawnFn = (cmd, args, options) => {
    seen = { cmd, args, env: options?.env as Record<string, string | undefined> };
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { child, io, signals, unrefs: () => unrefs, seen: () => seen, spawnFn };
}

test('a started child gets no E2E_* variable, GH_TOKEN only when asked, and the PATH override', () => {
  const s = stubborn();
  const start = createStart({ PATH: '/bin', E2E_SANDBOX_TOKEN: 'x', GH_TOKEN: 'old' }, () => {}, s.spawnFn);
  start(['gh', 'nibfin', 'dashboard'], { ghToken: 'tok', path: '/only' });
  deepEqual(s.seen()?.env, { PATH: '/only', GH_TOKEN: 'tok' });
  start(['podman', 'events']);
  deepEqual(s.seen()?.env, { PATH: '/bin' });
});

test('waitFor resolves on output, and rejects with the output tail on timeout', async () => {
  const s = stubborn();
  const r = createStart({}, () => {}, s.spawnFn)(['x']);
  s.io.stdout.write('starting\n');
  setTimeout(() => s.io.stderr.write('listening on http://127.0.0.1:4321/#proof=abc\n'), 5);
  const m = await r.waitFor(/127\.0\.0\.1:(\d+)/, 1000);
  equal(m[1], '4321');
  await rejects(r.waitFor(/never/, 20), /printed no \/never\/ within 20 ms: starting/);
});

test('stop escalates to SIGKILL, destroys stdio and unrefs even when close never arrives; a second stop is a no-op', async () => {
  const s = stubborn();
  const r = createStart({}, () => {}, s.spawnFn)(['x'], { graceMs: 10, closeMs: 10 });
  const first = await r.stop();
  deepEqual(s.signals, ['SIGTERM', 'SIGKILL']);
  equal(s.io.stdin.destroyed && s.io.stdout.destroyed && s.io.stderr.destroyed, true);
  equal(s.unrefs(), 1);
  equal(first.code, 137);
  await r.stop();
  deepEqual(s.signals, ['SIGTERM', 'SIGKILL']);
  equal(s.unrefs(), 1);
});

test('stop stops at SIGTERM when the child closes', async () => {
  const s = stubborn();
  const r = createStart({}, () => {}, s.spawnFn)(['x'], { graceMs: 1000 });
  s.child.kill = (sig: string) => (s.signals.push(sig), setTimeout(() => s.child.emit('close', null, sig), 1), true);
  const out = await r.stop();
  deepEqual(s.signals, ['SIGTERM']);
  equal(out.code, 128);
});

test('the real start runs a server-like child and stops it', async () => {
  const start = createStart({ ...process.env }, () => {});
  const r = start([process.execPath, '-e', 'console.log("ready");setInterval(()=>{},1000)']);
  await r.waitFor(/ready/, 5000);
  const out = await r.stop();
  match(out.stdout, /ready/);
});
