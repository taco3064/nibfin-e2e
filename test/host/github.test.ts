import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub, GATE_RATE_LIMIT, GitHubError, HARNESS_RATE_LIMIT } from '../../src/host/github.ts';
import type { RateLimitPolicy } from '../../src/host/github.ts';

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

const NOW = Date.parse('2026-11-27T16:00:00Z');

/** A client whose fetch answers from `responses` in order, with a recording sleep and log. */
function paced(responses: (() => Response)[], rateLimit: RateLimitPolicy | null = HARNESS_RATE_LIMIT) {
  const calls: { url: string; auth: string | null; method?: string; body?: unknown }[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let i = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), method: init?.method, body: init?.body });
    const next = responses[Math.min(i++, responses.length - 1)] as () => Response;
    return next();
  };
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', {
    rateLimit: rateLimit ?? undefined,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => NOW,
    log: (m) => void logs.push(m),
  });
  return { gh, calls, sleeps, logs };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const primary = (resetSec: number) =>
  json(403, { message: 'API rate limit exceeded for user ID 1.' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) });
const secondary = (status: number, retryAfter: number) =>
  json(status, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': String(retryAfter) });

test('a primary-limit 403 waits until the reset, then returns the resent response', async () => {
  const { gh, calls, sleeps, logs } = paced([primary(NOW / 1000 + 30), json(200, { ok: 1 })]);
  deepEqual(await gh.rest('GET', '/repos/o/r'), { status: 200, data: { ok: 1 } });
  deepEqual(sleeps, [31_000]);
  equal(calls.length, 2);
  deepEqual(calls.map((c) => c.auth), ['Bearer tok', 'Bearer tok']);
  equal(logs.length, 1);
  match(logs.join('\n'), /^GitHub GET \/repos\/o\/r hit the primary rate limit; waiting 31 s until 2026-11-27T16:00:31\.000Z \(retry 1\/3\)$/);
  equal(logs.join('\n').includes('tok'), false);
});

test('a secondary-limit 403 with retry-after waits that long, and a write is resent unchanged', async () => {
  const { gh, calls, sleeps, logs } = paced([secondary(403, 7), json(201, { id: 9 })]);
  deepEqual(await gh.rest('POST', '/repos/o/r/issues/1/comments', { body: 'x' }), { status: 201, data: { id: 9 } });
  deepEqual(sleeps, [7000]);
  deepEqual(calls.map((c) => [c.method, c.body]), [['POST', '{"body":"x"}'], ['POST', '{"body":"x"}']]);
  match(logs.join('\n'), /secondary rate limit; waiting 7 s/);
});

test('a 429 is waited out the same way, for list and graphql too', async () => {
  const a = paced([secondary(429, 3), json(200, [{ n: 1 }])]);
  deepEqual(await a.gh.list('/repos/o/r/issues'), [{ n: 1 }]);
  deepEqual(a.sleeps, [3000]);
  deepEqual(a.calls.map((c) => c.url), ['https://api.example/repos/o/r/issues?per_page=100&page=1', 'https://api.example/repos/o/r/issues?per_page=100&page=1']);
  const b = paced([secondary(429, 2), json(200, { data: { viewer: 'me' } })]);
  deepEqual(await b.gh.graphql('{ viewer }', {}), { viewer: 'me' });
  deepEqual(b.sleeps, [2000]);
});

test('without headers, a rate-limit message waits one minute, then doubles', async () => {
  const { gh, sleeps } = paced([json(403, { message: 'API rate limit exceeded' }), json(403, { message: 'API rate limit exceeded' }), json(200, {})]);
  equal((await gh.rest('GET', '/x')).status, 200);
  deepEqual(sleeps, [60_000, 120_000]);
});

test('a reset beyond the longest wait fails at once with the rate limit and the reset time', async () => {
  const { gh, calls, sleeps } = paced([primary(NOW / 1000 + 2 * 3600)]);
  const err = await gh.rest('GET', '/repos/o/r').catch((e: unknown) => e);
  ok(err instanceof GitHubError);
  equal(err.status, 403);
  equal(
    err.message,
    'GitHub GET /repos/o/r returned 403: API rate limit exceeded for user ID 1. (rate limit, primary; resets at 2026-11-27T18:00:01.000Z)',
  );
  equal(calls.length, 1);
  deepEqual(sleeps, []);
});

test('a plain 403 throws on the first call with its message unchanged and no wait', async () => {
  const { gh, calls, sleeps, logs } = paced([json(403, { message: 'Resource not accessible by integration' })]);
  await rejects(gh.rest('GET', '/x'), (e: unknown) => e instanceof GitHubError && e.status === 403 && e.message === 'GitHub GET /x returned 403: Resource not accessible by integration');
  equal(calls.length, 1);
  deepEqual(sleeps, []);
  deepEqual(logs, []);
  const other = paced([json(500, { message: 'boom' })]);
  await rejects(other.gh.rest('GET', '/x'), /returned 500: boom$/);
  equal(other.calls.length, 1);
});

test('the retries run out after maxRetries waits', async () => {
  const { gh, calls, sleeps } = paced([secondary(429, 1)]);
  await rejects(gh.rest('GET', '/x'), (e: unknown) => e instanceof GitHubError && e.status === 429 && /\(rate limit, secondary; resets at /.test(e.message));
  deepEqual(sleeps, [1000, 1000, 1000]);
  equal(calls.length, 4);
});

test('a rate-limited download API step waits, resends with the token, then follows the redirect without it', async () => {
  const { gh, calls, sleeps, logs } = paced([
    primary(NOW / 1000 + 5),
    () => new Response(null, { status: 302, headers: { Location: 'https://logs.example/signed?sig=abc' } }),
    () => new Response('log text', { status: 200 }),
  ]);
  deepEqual(await gh.download('/repos/o/r/actions/jobs/1/logs'), { status: 200, text: 'log text' });
  deepEqual(sleeps, [6000]);
  deepEqual(calls.map((c) => [c.url, c.auth]), [
    ['https://api.example/repos/o/r/actions/jobs/1/logs', 'Bearer tok'],
    ['https://api.example/repos/o/r/actions/jobs/1/logs', 'Bearer tok'],
    ['https://logs.example/signed?sig=abc', null],
  ]);
  equal(logs.length, 1);
  equal(/sig=abc|tok/.test(logs.join('\n')), false);
  const plain = paced([() => new Response('Forbidden', { status: 403 })]);
  await rejects(plain.gh.download('/x'), /GET \/x returned 403: Forbidden$/);
  deepEqual(plain.sleeps, []);
});

test('a client without rateLimit throws at once on a rate-limit 403, as before', async () => {
  const { gh, calls, sleeps } = paced([primary(NOW / 1000 + 5)], null);
  await rejects(gh.rest('GET', '/x'), /^Error: GitHub GET \/x returned 403: API rate limit exceeded for user ID 1\.$/);
  equal(calls.length, 1);
  deepEqual(sleeps, []);
});

test('a rate-limit 403 to a caller that allows 403 is waited out, not returned', async () => {
  const { gh, sleeps } = paced([primary(NOW / 1000 + 5), json(200, { rules: [] })]);
  deepEqual(await gh.rest('GET', '/repos/o/r/rulesets', undefined, [403]), { status: 200, data: { rules: [] } });
  deepEqual(sleeps, [6000]);
  const allowed = paced([json(403, { message: 'Upgrade to GitHub Pro' })]);
  equal((await allowed.gh.rest('GET', '/x', undefined, [403])).status, 403);
  deepEqual(allowed.sleeps, []);
});

test('the gate preset caps all waits of a client at four minutes', async () => {
  const { gh, sleeps } = paced([secondary(403, 120), json(200, {}), secondary(403, 120), json(200, {}), secondary(403, 120)], GATE_RATE_LIMIT);
  equal((await gh.rest('GET', '/a')).status, 200);
  equal((await gh.rest('GET', '/b')).status, 200);
  await rejects(gh.rest('GET', '/c'), /^Error: GitHub GET \/c returned 403: You have exceeded a secondary rate limit\. \(rate limit, secondary; resets at 2026-11-27T16:02:00\.000Z\)$/);
  deepEqual(sleeps, [120_000, 120_000]);
});
