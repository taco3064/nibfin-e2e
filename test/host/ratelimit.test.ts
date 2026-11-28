import { deepEqual, equal, match, doesNotMatch, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { createHostContext } from '../../src/host/context.ts';
import { deferredRunning } from '../../src/host/exec.ts';
import type { Running } from '../../src/host/exec.ts';
import { createGitHub } from '../../src/host/github.ts';
import { describeLimit, readCoreLimit, waitForCoreLimit } from '../../src/host/ratelimit.ts';
import type { HostServices } from '../../src/host/services.ts';
import { fakeExec, fakeRunning } from './fakes.ts';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const NOW = 1_795_889_359_000;

/** A GitHub whose `GET /rate_limit` answers with `core`, or with `status` and a message. */
function limitGitHub(answer: { core?: unknown; status?: number }) {
  const reads: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    reads.push(`${init?.method} ${String(url)}`);
    const status = answer.status ?? 200;
    const body = status === 200 ? { resources: { core: answer.core } } : { message: 'Server Error' };
    return new Response(JSON.stringify(body), { status, headers: { 'x-ratelimit-remaining': '0' } });
  }) as typeof fetch;
  return { github: createGitHub(() => TOKEN, fetchFn), reads };
}

const core = (remaining: number, resetInS: number) => ({
  limit: 5000,
  remaining,
  reset: NOW / 1000 + resetInS,
  used: 5000 - remaining,
});

function opts(extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  return {
    lines,
    sleeps,
    o: {
      log: (l: string) => lines.push(l),
      sleep: async (ms: number) => void sleeps.push(ms),
      now: () => NOW,
      what: 'gh nibfin runner remove',
      ...extra,
    },
  };
}

test('readCoreLimit: reads resources.core; a malformed body throws', async () => {
  deepEqual(await readCoreLimit(limitGitHub({ core: core(42, 600) }).github), {
    limit: 5000,
    remaining: 42,
    resetAt: NOW + 600_000,
  });
  await rejects(readCoreLimit(limitGitHub({ core: { remaining: '1' } }).github), /no integer resources\.core/);
  match(describeLimit({ limit: 5000, remaining: 0, resetAt: NOW }), /^0 of 5000 core REST calls left, resetting at 2026-/);
});

test('waitForCoreLimit: with room left it neither sleeps nor logs', async () => {
  const { lines, sleeps, o } = opts();
  const r = await waitForCoreLimit(limitGitHub({ core: core(500, 600) }).github, o);
  deepEqual([lines, sleeps, r.waitedMs, r.read?.remaining], [[], [], 0, 500]);
});

test('waitForCoreLimit: with little left it sleeps until the reset plus 1 s and logs one line without the token', async () => {
  const { lines, sleeps, o } = opts();
  const r = await waitForCoreLimit(limitGitHub({ core: core(3, 574) }).github, o);
  deepEqual(sleeps, [575_000]);
  equal(r.waitedMs, 575_000);
  equal(lines.length, 1);
  equal(lines[0], 'GitHub core REST limit has 3 of 5000 left; waiting 575 s for the reset before gh nibfin runner remove');
  doesNotMatch(lines[0] ?? '', /ghp_|Bearer|x-ratelimit/i);
});

test('waitForCoreLimit: a reset beyond the bound is not waited for, with one line', async () => {
  const { lines, sleeps, o } = opts({ maxWaitMs: 60_000 });
  const r = await waitForCoreLimit(limitGitHub({ core: core(0, 600) }).github, o);
  deepEqual([sleeps, r.waitedMs], [[], 0]);
  equal(lines.length, 1);
  match(lines[0] ?? '', /0 of 5000 left; the reset in 601 s is beyond the 60 s wait limit, running before gh nibfin runner remove without waiting/);
});

test('waitForCoreLimit: a failed or malformed read is named in one line and does not wait', async () => {
  for (const answer of [{ status: 500 }, { core: { limit: 5000 } }]) {
    const { lines, sleeps, o } = opts();
    const r = await waitForCoreLimit(limitGitHub(answer).github, o);
    deepEqual([sleeps, r.waitedMs, r.read], [[], 0, undefined]);
    equal(lines.length, 1);
    match(lines[0] ?? '', /^reading the GitHub core REST limit before gh nibfin runner remove failed \(.+\); running without waiting$/);
    match(r.readError ?? '', answer.status ? /returned 500: Server Error/ : /no integer/);
    doesNotMatch(lines[0] ?? '', /ghp_|Bearer/);
  }
});

/** A host whose limit read answers `answer`; records the order of reads, execs and starts. */
function host(answer: { core?: unknown; status?: number }) {
  const order: string[] = [];
  const lines: string[] = [];
  const g = limitGitHub(answer);
  const github = {
    ...g.github,
    rest: async <T>(method: string, path: string, body?: unknown, allow?: number[]) => {
      order.push(`${method} ${path}`);
      return g.github.rest<T>(method, path, body, allow);
    },
  };
  const exec = fakeExec((argv) => (order.push(argv.join(' ')), undefined));
  const services = {
    github,
    exec: exec.exec,
    start: (argv: string[]) => (order.push(`start ${argv.join(' ')}`), fakeRunning('ready on 8080')),
    repoRoot: '/tmp/x',
    sandboxToken: () => TOKEN,
    log: (l: string) => lines.push(l),
  } as unknown as HostServices;
  return { ctx: createHostContext(services), order, lines, exec };
}

test('ghNibfin reads the limit before the command, and runs it unchanged after a failed read', async () => {
  const ok = host({ core: core(4000, 600) });
  equal((await ok.ctx.ghNibfin(['runner', 'list'])).code, 0);
  deepEqual(ok.order, ['GET /rate_limit', 'gh nibfin runner list']);
  equal(ok.exec.calls[0]?.options.ghToken, TOKEN);

  const failed = host({ status: 500 });
  equal((await failed.ctx.ghNibfin(['runner', 'list'])).code, 0);
  deepEqual(failed.order, ['GET /rate_limit', 'gh nibfin runner list']);
  equal(failed.lines.length, 1);
  match(failed.lines[0] ?? '', /before gh nibfin runner list failed/);
});

test('startGhNibfin spawns only after the limit read, and waitFor delegates to the child', async () => {
  const h = host({ core: core(4000, 600) });
  const child = h.ctx.startGhNibfin(['dashboard']);
  equal(child.output(), '');
  deepEqual(h.order, ['GET /rate_limit']);
  const m = await child.waitFor(/ready on (\d+)/, 1000);
  equal(m[1], '8080');
  deepEqual(h.order, ['GET /rate_limit', 'start gh nibfin dashboard']);
  equal(child.output(), 'ready on 8080');
});

test('deferredRunning: stop() before the start never spawns, resolves at once, and waitFor then rejects', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  let spawned = 0;
  const child = deferredRunning(ready, () => (spawned++, fakeRunning('x')));
  const waiting = child.waitFor(/x/, 1000);
  deepEqual(await child.stop(), { code: 0, stdout: '', stderr: '' });
  release();
  await rejects(waiting, /stopped before it started/);
  equal(spawned, 0);
});

test('deferredRunning: a start that throws surfaces from waitFor and stop; after the start, stop delegates', async () => {
  const broken = deferredRunning(Promise.resolve(), () => {
    throw new Error('cannot run gh');
  });
  await rejects(broken.waitFor(/x/, 10), /cannot run gh/);
  await rejects(broken.stop(), /cannot run gh/);

  const inner = fakeRunning('out');
  const child: Running = deferredRunning(Promise.reject(new Error('advisory')), () => inner);
  await child.waitFor(/out/, 10);
  deepEqual(await child.stop(), { code: 0, stdout: 'out', stderr: '' });
  equal(inner.stops, 1);
});
