import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub } from '../../src/host/github.ts';
import type { Exec } from '../../src/host/exec.ts';
import { createHostOperations } from '../../src/host/operations.ts';
import type { HostServices } from '../../src/host/services.ts';
import { fakeExec, fakeRunning } from './fakes.ts';

function services(
  exec: Exec,
  env: Record<string, string | undefined> = { E2E_SANDBOX_TOKEN: 'sbx-token', E2E_CLAUDE_TOKEN: 'claude-token' },
  fetchFn?: typeof fetch,
): HostServices {
  return {
    env,
    exec,
    fetch: fetchFn ?? fetch,
    github: createGitHub(() => 'sbx-token', fetchFn),
    repoRoot: '/tmp/none',
    workDir: () => '/tmp/none',
    sandboxToken: () => 'sbx-token',
    start: () => fakeRunning(),
    peerGithub: createGitHub(() => 'peer-token', fetchFn),
    peerToken: () => 'peer-token',
    log: () => {},
  };
}

test('secretValues returns the set tokens; ownerLogin and ownerId read GET /user once', async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => (
    calls++,
    new Response(JSON.stringify({ login: 'owner', id: 42 }), { status: 200 })
  );
  const ops = createHostOperations(services(fakeExec().exec, { E2E_SANDBOX_TOKEN: 'a', E2E_CLAUDE_TOKEN: ' ' }, fetchFn));
  deepEqual(ops.secretValues(), ['a']);
  deepEqual([await ops.ownerLogin(), await ops.ownerId(), calls], ['owner', 42, 1]);
});

test('listByLink follows Link next cursors on the API host only, and stops at the page limit', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const pages: Record<string, { body: unknown[]; next?: string }> = {
    'https://api.github.com/repos/o/r/activity?time_period=day&per_page=100': {
      body: [{ id: 1 }],
      next: 'https://api.github.com/repos/o/r/activity?per_page=100&after=c1',
    },
    'https://api.github.com/repos/o/r/activity?per_page=100&after=c1': {
      body: [{ id: 2 }],
      next: 'https://evil.example/steal',
    },
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const p = pages[url];
    if (!p) return new Response('[]', { status: 404 });
    return new Response(JSON.stringify(p.body), {
      status: 200,
      headers: p.next ? { link: `<${p.next}>; rel="next"` } : {},
    });
  };
  const gh = createGitHub(() => 'tok', fetchFn);
  deepEqual(await gh.listByLink('/repos/o/r/activity?time_period=day'), [{ id: 1 }, { id: 2 }]);
  equal(
    seen.some((s) => s.url.startsWith('https://evil.example')),
    false,
  );
  const loop: typeof fetch = async () =>
    new Response('[{"id":1}]', {
      status: 200,
      headers: { link: '<https://api.github.com/repos/o/r/activity?after=x>; rel="next"' },
    });
  await rejects(createGitHub(() => 'tok', loop).listByLink('/repos/o/r/activity', 3), /more than 3 pages/);
});
