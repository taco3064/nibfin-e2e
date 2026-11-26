import { createGitHub } from '../../src/host/github.ts';
import type { RunContext } from '../../src/types.ts';
import { fakeHostContext } from '../host/fakes.ts';

export type Handler = (body: Record<string, unknown> | undefined, url: URL) => { status?: number; data?: unknown; headers?: Record<string, string> } | unknown;

/**
 * A GitHub fake answering "METHOD /path" (query ignored) from a table of values or
 * handlers; unknown routes answer 404. Records every call as "METHOD /path?query".
 */
export function routes(table: Record<string, Handler | object>) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    const h = table[`${method} ${url.pathname}`];
    if (!h) return new Response(JSON.stringify({ message: `no route ${method} ${url.pathname}` }), { status: 404 });
    const out = typeof h === 'function' ? (h as Handler)(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined, url) : h;
    const r = (out !== null && typeof out === 'object' && ('status' in out || 'data' in out) ? out : { data: out }) as { status?: number; data?: unknown; headers?: Record<string, string> };
    const status = r.status ?? 200;
    return new Response(status === 204 || r.data === undefined ? null : JSON.stringify(r.data), { status, headers: r.headers });
  };
  return { fetchFn, calls, github: createGitHub(() => 'tok', fetchFn) };
}

/** A run context over the fake GitHub, with the given secrets and log sink. */
export function context(github: RunContext['github'], extra: Partial<RunContext> = {}): RunContext {
  return {
    ...fakeHostContext,
    sandbox: { execution: 'o/exec', peer: 'o/peer' },
    github,
    target: { ghNibfinCommit: 'a'.repeat(40), platform: 'linux' },
    log: () => {},
    facts: () => undefined,
    ...extra,
  };
}

/** A fake clock whose sleep advances time. */
export function clock(start = Date.parse('2026-11-26T10:00:00Z')) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}
