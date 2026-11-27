import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub, GitHubError } from '../../src/host/github.ts';

test('download follows the redirect without the Authorization header and keeps its URL out of errors', async () => {
  const seen: { url: string; auth: string | null; redirect?: string }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    if (url.startsWith('https://api.example/')) return new Response(null, { status: 302, headers: { Location: 'https://logs.example/signed?sig=abc' } });
    if (url.includes('sig=abc')) return new Response('2026-11-26T00:00:00Z hello\n', { status: 200 });
    return new Response('gone', { status: 410 });
  };
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example');
  deepEqual(await gh.download('/repos/o/r/actions/jobs/1/logs'), { status: 200, text: '2026-11-26T00:00:00Z hello\n' });
  deepEqual(seen.map((s) => [s.auth, s.redirect]), [['Bearer tok', 'manual'], [null, undefined]]);

  const failing = createGitHub(() => 'tok', async (input) =>
    String(input).startsWith('https://api.example/') ? new Response(null, { status: 302, headers: { Location: 'https://logs.example/x?sig=secret' } }) : new Response('no', { status: 403 }),
  'https://api.example');
  const err = await failing.download('/repos/o/r/actions/jobs/1/logs').catch((e: Error) => e.message);
  equal(String(err).includes('sig=secret'), false);
  equal(String(err).includes('403'), true);
  const allowed = createGitHub(() => 'tok', async () => new Response('{"message":"Not Found"}', { status: 404 }), 'https://api.example');
  equal((await allowed.download('/x', [404])).status, 404);
  await rejects(allowed.download('/x'), /GET \/x returned 404/);
});

const NOW = 1_800_000_000_000;

function waitHarness(maxWaitMs?: number) {
  const slept: number[] = [];
  const lines: string[] = [];
  return {
    slept,
    lines,
    wait: { log: (l: string) => lines.push(l), maxWaitMs, sleep: async (ms: number) => void slept.push(ms), now: () => NOW },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const primary = (resetInS: number, status = 403) =>
  json({ message: 'API rate limit exceeded for user ID 1.' }, status, {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(NOW / 1000 + resetInS),
  });

/** A fake fetch that answers each call with the next response and records method and URL. */
function sequence(...responses: Response[]) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next;
  };
  return { calls, fetchFn };
}

test('a primary rate limit on a read is waited out until the reset and the read repeated', async () => {
  const h = waitHarness();
  const f = sequence(primary(30), json({ id: 1 }));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  deepEqual(await gh.rest('GET', '/repos/o/r'), { status: 200, data: { id: 1 } });
  deepEqual(h.slept, [31_000]);
  deepEqual(h.lines, ['GitHub GET /repos/o/r rate-limited (403); waiting 31 s']);
  deepEqual(f.calls, ['GET https://api.example/repos/o/r', 'GET https://api.example/repos/o/r']);
});

test('a secondary rate limit with retry-after is waited out', async () => {
  const h = waitHarness();
  const f = sequence(json({ message: 'slow down' }, 429, { 'retry-after': '5' }), json([]));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  deepEqual((await gh.rest('GET', '/x')).data, []);
  deepEqual(h.slept, [5_000]);
});

test('a secondary rate limit named only by its message backs off exponentially', async () => {
  const h = waitHarness();
  const secondary = () => json({ message: 'You have exceeded a secondary rate limit.' }, 403);
  const f = sequence(secondary(), secondary(), json({ ok: true }));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  deepEqual((await gh.rest('GET', '/x')).data, { ok: true });
  deepEqual(h.slept, [60_000, 120_000]);
});

test('a reset beyond the wait limit fails at once and says so', async () => {
  const h = waitHarness(10 * 60_000);
  const f = sequence(primary(3600));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  const err = await gh.rest('GET', '/x').catch((e: unknown) => e);
  ok(err instanceof GitHubError);
  equal(err.status, 403);
  match(err.message, /^GitHub GET \/x returned 403: API rate limit exceeded.*; rate limit resets in 3601 s, beyond the 600 s wait limit$/);
  deepEqual(h.slept, []);
  equal(f.calls.length, 1);
});

test('a rate limit that persists after a wait fails with a message that says it waited', async () => {
  const h = waitHarness(60_000);
  const f = sequence(primary(20, 429), primary(50, 429));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  const err = await gh.rest('GET', '/x').catch((e: unknown) => e);
  ok(err instanceof GitHubError);
  equal(err.status, 429);
  match(err.message, /beyond the 60 s wait limit \(after waiting 21 s for the rate limit\)$/);
  deepEqual(h.slept, [21_000]);
});

test('a plain 403 fails at once without waiting', async () => {
  const h = waitHarness();
  const f = sequence(json({ message: 'Resource not accessible by integration' }, 403));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  await rejects(gh.rest('GET', '/x'), /GET \/x returned 403: Resource not accessible by integration$/);
  deepEqual(h.slept, []);
});

test('rate-limited writes, GraphQL included, are not repeated', async () => {
  for (const run of [
    (gh: ReturnType<typeof createGitHub>) => gh.rest('PUT', '/x', { a: 1 }),
    (gh: ReturnType<typeof createGitHub>) => gh.rest('POST', '/x', { a: 1 }),
    (gh: ReturnType<typeof createGitHub>) => gh.graphql('query { viewer { login } }', {}),
  ]) {
    const h = waitHarness();
    const f = sequence(primary(5));
    const err = await run(createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait)).catch((e: unknown) => e);
    ok(err instanceof GitHubError);
    equal(err.message.includes('waiting'), false);
    deepEqual(h.slept, []);
    equal(f.calls.length, 1);
  }
});

test('a list rate-limited on page 2 continues from page 2', async () => {
  const h = waitHarness();
  const page1 = Array.from({ length: 100 }, (_, i) => i);
  const f = sequence(json(page1), primary(10), json([100, 101]));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  deepEqual(await gh.list('/repos/o/r/issues?state=open'), [...page1, 100, 101]);
  deepEqual(f.calls, [
    'GET https://api.example/repos/o/r/issues?state=open&per_page=100&page=1',
    'GET https://api.example/repos/o/r/issues?state=open&per_page=100&page=2',
    'GET https://api.example/repos/o/r/issues?state=open&per_page=100&page=2',
  ]);
  deepEqual(h.slept, [11_000]);
});

test('a listByLink rate-limited on a cursor page repeats the same cursor', async () => {
  const h = waitHarness();
  const next = 'https://api.example/repos/o/r/activity?per_page=100&after=c1';
  const f = sequence(json([1], 200, { link: `<${next}>; rel="next"` }), primary(1), json([2]));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  deepEqual(await gh.listByLink('/repos/o/r/activity'), [1, 2]);
  deepEqual(f.calls.slice(1), [`GET ${next}`, `GET ${next}`]);
});

test('a status listed in allow is returned, not waited', async () => {
  const h = waitHarness();
  const f = sequence(primary(5));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  equal((await gh.rest('GET', '/x', undefined, [403])).status, 403);
  deepEqual(h.slept, []);
});

test('download waits out a rate-limited API response and still drops the token on the redirect', async () => {
  const h = waitHarness();
  const auth: (string | null)[] = [];
  const responses = [primary(2), new Response(null, { status: 302, headers: { Location: 'https://logs.example/signed?sig=abc' } }), new Response('log\n')];
  const fetchFn: typeof fetch = async (_input, init) => {
    auth.push(new Headers(init?.headers).get('authorization'));
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next;
  };
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', h.wait);
  deepEqual(await gh.download('/repos/o/r/actions/jobs/1/logs'), { status: 200, text: 'log\n' });
  deepEqual(auth, ['Bearer tok', 'Bearer tok', null]);
  deepEqual(h.slept, [3_000]);
  equal(h.lines.some((l) => l.includes('sig=')), false);
});

test('download never waits on the redirected response', async () => {
  const h = waitHarness();
  const f = sequence(new Response(null, { status: 302, headers: { Location: 'https://logs.example/x?sig=secret' } }), primary(2));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  const err = await gh.download('/logs').catch((e: Error) => e.message);
  equal(err, 'GitHub GET /logs returned 403: the redirected download failed');
  deepEqual(h.slept, []);
});

test('a client created without the wait option fails at once on a rate limit', async () => {
  const f = sequence(primary(5));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example');
  await rejects(gh.rest('GET', '/x'), (e: unknown) => e instanceof GitHubError && e.status === 403 && !e.message.includes('wait'));
  equal(f.calls.length, 1);
});
