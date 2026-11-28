import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub, GitHubError, GitHubNoResponse } from '../../src/host/github.ts';

test('download follows the redirect without the Authorization header and keeps its URL out of errors', async () => {
  const seen: { url: string; auth: string | null; redirect?: string }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    if (url.startsWith('https://api.example/'))
      return new Response(null, { status: 302, headers: { Location: 'https://logs.example/signed?sig=abc' } });
    if (url.includes('sig=abc')) return new Response('2026-11-26T00:00:00Z hello\n', { status: 200 });
    return new Response('gone', { status: 410 });
  };
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example');
  deepEqual(await gh.download('/repos/o/r/actions/jobs/1/logs'), { status: 200, text: '2026-11-26T00:00:00Z hello\n' });
  deepEqual(
    seen.map((s) => [s.auth, s.redirect]),
    [
      ['Bearer tok', 'manual'],
      [null, undefined],
    ],
  );

  const failing = createGitHub(
    () => 'tok',
    async (input) =>
      String(input).startsWith('https://api.example/')
        ? new Response(null, { status: 302, headers: { Location: 'https://logs.example/x?sig=secret' } })
        : new Response('no', { status: 403 }),
    'https://api.example',
  );
  const err = await failing.download('/repos/o/r/actions/jobs/1/logs').catch((e: Error) => e.message);
  equal(String(err).includes('sig=secret'), false);
  equal(String(err).includes('403'), true);
  const allowed = createGitHub(
    () => 'tok',
    async () => new Response('{"message":"Not Found"}', { status: 404 }),
    'https://api.example',
  );
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
    wait: {
      log: (l: string) => lines.push(l),
      maxWaitMs,
      sleep: async (ms: number) => void slept.push(ms),
      now: () => NOW,
    },
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
  match(
    err.message,
    /^GitHub GET \/x returned 403: API rate limit exceeded.*; rate limit resets in 3601 s, beyond the 600 s wait limit$/,
  );
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
  const responses = [
    primary(2),
    new Response(null, { status: 302, headers: { Location: 'https://logs.example/signed?sig=abc' } }),
    new Response('log\n'),
  ];
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
  equal(
    h.lines.some((l) => l.includes('sig=')),
    false,
  );
});

test('download never waits on the redirected response', async () => {
  const h = waitHarness();
  const f = sequence(
    new Response(null, { status: 302, headers: { Location: 'https://logs.example/x?sig=secret' } }),
    primary(2),
  );
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example', h.wait);
  const err = await gh.download('/logs').catch((e: Error) => e.message);
  equal(err, 'GitHub GET /logs returned 403: the redirected download failed');
  deepEqual(h.slept, []);
});

test('a client created without the wait option fails at once on a rate limit', async () => {
  const f = sequence(primary(5));
  const gh = createGitHub(() => 'tok', f.fetchFn, 'https://api.example');
  await rejects(
    gh.rest('GET', '/x'),
    (e: unknown) => e instanceof GitHubError && e.status === 403 && !e.message.includes('wait'),
  );
  equal(f.calls.length, 1);
});

/** A rejection shaped like Node's: \`TypeError('fetch failed')\` with the system error in \`cause\`. */
const noResponse = (code: string) =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`read ${code}`), { code }) });

function retryHarness() {
  const slept: number[] = [];
  const lines: string[] = [];
  return { slept, lines, retry: { log: (l: string) => lines.push(l), sleep: async (ms: number) => void slept.push(ms) } };
}

/** A fake fetch that answers each call with the next step: a Response, or an error to reject with. */
function steps(...answers: (Response | Error)[]) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const next = answers.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchFn };
}

test('a read that gets no response once is sent again and returns the second response', async () => {
  const { slept, lines, retry } = retryHarness();
  const { calls, fetchFn } = steps(noResponse('ECONNRESET'), json({ ok: 1 }));
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', undefined, retry);
  deepEqual(await gh.rest('GET', '/repos/o/r/actions/runners'), { status: 200, data: { ok: 1 } });
  equal(calls.length, 2);
  deepEqual(slept, [3000]);
  equal(lines.length, 1);
  match(String(lines[0]), /^GitHub GET \/repos\/o\/r\/actions\/runners got no response \(ECONNRESET\); trying again in 3 s \(try 2 of 3\)$/);
  equal(String(lines[0]).includes('tok'), false);
});

test('a read that never gets a response fails after the bounded tries and names the call and the cause', async () => {
  const { slept, lines, retry } = retryHarness();
  const original = noResponse('ENOTFOUND');
  const { calls, fetchFn } = steps(original, noResponse('ENOTFOUND'), noResponse('ENOTFOUND'));
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', undefined, retry);
  const err = await gh.rest('GET', '/x').catch((e: unknown) => e);
  ok(err instanceof GitHubNoResponse);
  equal(err instanceof GitHubError, false);
  equal(err.message, 'GitHub GET /x got no response: ENOTFOUND (after 3 tries)');
  ok(err.cause instanceof TypeError);
  equal(calls.length, 3);
  deepEqual(slept, [3000, 3000]);
  equal(lines.length, 2);
  equal(err.message.includes('tok'), false);
});

test('a write or GraphQL call that gets no response is not repeated', async () => {
  const { slept, retry } = retryHarness();
  const post = steps(noResponse('ECONNRESET'));
  const gh = createGitHub(() => 'tok', post.fetchFn, 'https://api.example', undefined, retry);
  await rejects(gh.rest('POST', '/repos/o/r/dispatches', {}), (e: unknown) => {
    ok(e instanceof GitHubNoResponse);
    equal(e.message, 'GitHub POST /repos/o/r/dispatches got no response: ECONNRESET');
    return true;
  });
  equal(post.calls.length, 1);
  const gql = steps(noResponse('UND_ERR_CONNECT_TIMEOUT'));
  const g2 = createGitHub(() => 'tok', gql.fetchFn, 'https://api.example', undefined, retry);
  await rejects(g2.graphql('{ viewer { login } }', {}), /^GitHubNoResponse: GitHub POST \/graphql got no response: UND_ERR_CONNECT_TIMEOUT$/);
  equal(gql.calls.length, 1);
  deepEqual(slept, []);
});

test('a list page that gets no response once continues from that page', async () => {
  const { retry } = retryHarness();
  const full = Array.from({ length: 100 }, (_, i) => i);
  const { calls, fetchFn } = steps(json(full), noResponse('ECONNRESET'), json([100]));
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', undefined, retry);
  equal((await gh.list<number>('/r')).length, 101);
  deepEqual(calls.slice(1), ['GET https://api.example/r?per_page=100&page=2', 'GET https://api.example/r?per_page=100&page=2']);
});

test('a listByLink cursor page that gets no response once repeats the same cursor', async () => {
  const { retry } = retryHarness();
  const next = 'https://api.example/r?per_page=100&cursor=abc';
  const { calls, fetchFn } = steps(json([1], 200, { link: `<${next}>; rel="next"` }), noResponse('ECONNRESET'), json([2]));
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', undefined, retry);
  deepEqual(await gh.listByLink<number>('/r'), [1, 2]);
  deepEqual(calls.slice(1), [`GET ${next}`, `GET ${next}`]);
});

test('a redirected download that gets no response keeps the redirect URL out of the message and the log', async () => {
  const { lines, retry } = retryHarness();
  const signed = 'https://logs.example/signed?sig=secret';
  const redirect = () => new Response(null, { status: 302, headers: { Location: signed } });
  // The cause message carries the redirect host, as Node's would; only its code may be used.
  const reject = () =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND logs.example'), { code: 'ENOTFOUND' }),
    });
  const { calls, fetchFn } = steps(redirect(), reject(), reject(), reject());
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', undefined, retry);
  const err = await gh.download('/repos/o/r/actions/jobs/1/logs').catch((e: unknown) => e);
  ok(err instanceof GitHubNoResponse);
  equal(
    err.message,
    'GitHub GET /repos/o/r/actions/jobs/1/logs: the redirected download got no response: ENOTFOUND (after 3 tries)',
  );
  equal(calls.length, 4);
  for (const text of [err.message, ...lines]) {
    equal(text.includes('sig='), false);
    equal(text.includes('logs.example'), false);
  }
  const noCode = steps(redirect(), new TypeError('fetch failed', { cause: new Error('connect to logs.example failed') }));
  const g2 = createGitHub(() => 'tok', noCode.fetchFn, 'https://api.example');
  await rejects(g2.download('/l'), (e: unknown) => {
    ok(e instanceof GitHubNoResponse);
    equal(e.message, 'GitHub GET /l: the redirected download got no response: no error code');
    return true;
  });
});

test('the API-host download step that gets no response once is sent again', async () => {
  const { retry } = retryHarness();
  const { calls, fetchFn } = steps(noResponse('ECONNRESET'), new Response('log', { status: 200 }));
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', undefined, retry);
  deepEqual(await gh.download('/l'), { status: 200, text: 'log' });
  equal(calls.length, 2);
});

test('a 500 or a plain 403 response is not treated as no response', async () => {
  const { slept, lines, retry } = retryHarness();
  for (const status of [500, 403]) {
    const { calls, fetchFn } = steps(json({ message: 'nope' }, status));
    const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', undefined, retry);
    await rejects(gh.rest('GET', '/x'), (e: unknown) => e instanceof GitHubError && e.status === status);
    equal(calls.length, 1);
  }
  deepEqual(slept, []);
  deepEqual(lines, []);
});

test('a client without the retry option tries once and still names the call and the cause', async () => {
  const { calls, fetchFn } = steps(noResponse('ECONNRESET'));
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example');
  await rejects(gh.rest('GET', '/x'), /^GitHubNoResponse: GitHub GET \/x got no response: ECONNRESET$/);
  equal(calls.length, 1);
});

test('a cause without a code is named by its deepest message, also through an AggregateError', async () => {
  const bad = steps(new TypeError('fetch failed', { cause: new Error('bad port') }));
  await rejects(createGitHub(() => 'tok', bad.fetchFn, 'https://api.example').rest('GET', '/x'), /got no response: bad port$/);
  const dual = steps(
    new TypeError('fetch failed', {
      cause: new AggregateError([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })], ''),
    }),
  );
  await rejects(createGitHub(() => 'tok', dual.fetchFn, 'https://api.example').rest('GET', '/x'), /got no response: ECONNREFUSED$/);
});

test('an abort is rethrown unchanged and not retried', async () => {
  const { slept, retry } = retryHarness();
  const abort = new DOMException('This operation was aborted', 'AbortError');
  const { calls, fetchFn } = steps(abort, json({}));
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', undefined, retry);
  const err = await gh.rest('GET', '/x').catch((e: unknown) => e);
  equal(err, abort);
  equal(calls.length, 1);
  deepEqual(slept, []);
});

test('a no-response retry does not count against the rate-limit wait', async () => {
  const w = waitHarness(120_000);
  const r = retryHarness();
  const { calls, fetchFn } = steps(primary(60), noResponse('ECONNRESET'), noResponse('ECONNRESET'), json({ ok: 1 }));
  const gh = createGitHub(() => 'tok', fetchFn, 'https://api.example', w.wait, r.retry);
  deepEqual(await gh.rest('GET', '/x'), { status: 200, data: { ok: 1 } });
  equal(calls.length, 4);
  deepEqual(w.slept, [61_000]);
  deepEqual(r.slept, [3000, 3000]);
});
