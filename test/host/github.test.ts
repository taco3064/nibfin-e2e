import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub } from '../../src/host/github.ts';

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
