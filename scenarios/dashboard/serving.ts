// Proposal R9.26 (127.0.0.1 only, one-time proof in the fragment, Origin/Host checks)
// and R9.28 (the build is embedded in the binary; no Node at run time).
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { delimiter, join } from 'node:path';
import type { RunContext } from '../../src/types.ts';
import { check, sessionFrom } from './checks.ts';
import { call, defineScenario, openDashboard, openPage, startDashboard } from './support.ts';

/**
 * `accepted` when a TCP connection to the address is accepted within 3 s; `refused` when it
 * is refused, unreachable or times out; otherwise the error code, which proves nothing either way.
 */
const UNREACHABLE = ['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH'];

function connectTo(address: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host: address, port, timeout: 3000 });
    s.once('connect', () => (s.destroy(), resolve('accepted')));
    s.once('timeout', () => (s.destroy(), resolve('refused')));
    s.once('error', (e: NodeJS.ErrnoException) =>
      resolve(UNREACHABLE.includes(e.code ?? '') ? 'refused' : (e.code ?? 'error')),
    );
  });
}

const ok = (s: number) => s >= 200 && s < 300;

/** A PATH directory with every command of the host's PATH except Node and its tools. */
function pathWithoutNode(ctx: RunContext): string {
  const dir = join(ctx.workDir(), 'no-node-bin');
  mkdirSync(dir, { recursive: true });
  const skip = /^(node|nodejs|npm|npx|corepack|pnpm|yarn|bun|deno)$/;
  for (const d of (ctx.browserEnv().PATH ?? '').split(delimiter)) {
    if (!d || !existsSync(d)) continue;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (skip.test(n) || existsSync(join(dir, n))) continue;
      try {
        if (statSync(join(d, n)).isFile()) symlinkSync(join(d, n), join(dir, n));
      } catch {
        // unreadable or racing entries are skipped
      }
    }
  }
  return dir;
}

export const dashboardServing = defineScenario({
  id: 'dashboard-serving',
  rules: ['R9.26', 'R9.28'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    const notes: string[] = [];
    // R9.26
    const dash = await startDashboard(ctx, secrets);
    try {
      const url = new URL(dash.sessionUrl);
      check(url.hostname === '127.0.0.1', 'R9.26', 'the session URL on 127.0.0.1', url.hostname);
      check(
        !url.search && url.hash.includes('proof='),
        'R9.26',
        'the proof only in the URL fragment',
        'a query string or no fragment',
      );
      const local = await connectTo('127.0.0.1', dash.port);
      check(local === 'accepted', 'R9.26', `127.0.0.1:${dash.port} to accept connections`, local);
      // Link-local IPv6 addresses need a scope id to be dialled at all, so they are skipped.
      const others = [
        '::1',
        ...Object.values(networkInterfaces()).flatMap((l) =>
          (l ?? [])
            .filter((i) => !i.internal && !(i.family === 'IPv6' && /^fe80:/i.test(i.address)))
            .map((i) => i.address),
        ),
      ];
      for (const a of others) {
        const got = await connectTo(a, dash.port);
        check(
          got === 'refused',
          'R9.26',
          `port ${dash.port} refused on ${a}`,
          got === 'accepted' ? 'a connection was accepted' : `an inconclusive ${got}`,
        );
      }
      notes.push(`bound only to 127.0.0.1 (refused on ${others.length} other addresses)`);

      const host = `127.0.0.1:${dash.port}`;
      const first = await call(dash.port, 'POST', '/api/session', { Host: host, 'X-Nibfin-Proof': dash.proof });
      check(ok(first.status), 'R9.26', 'the first proof exchange to succeed', `HTTP ${first.status}`);
      const session = sessionFrom(first);
      check(session, 'R9.26', 'a session from the proof exchange', 'no session field or header');
      secrets.add(session as string);
      const second = await call(dash.port, 'POST', '/api/session', { Host: host, 'X-Nibfin-Proof': dash.proof });
      check(!ok(second.status), 'R9.26', 'a second exchange of the same proof to be refused', `HTTP ${second.status}`);
      const without = await call(dash.port, 'GET', '/api/commands', { Host: host });
      check(!ok(without.status), 'R9.26', 'an API call without a session to be refused', `HTTP ${without.status}`);
      const withSession = await call(dash.port, 'GET', '/api/commands', {
        Host: host,
        'X-Nibfin-Session': session as string,
      });
      check(ok(withSession.status), 'R9.26', 'an API call with the session to succeed', `HTTP ${withSession.status}`);
      const badHost = await call(dash.port, 'GET', '/api/commands', {
        Host: `localhost:${dash.port}`,
        'X-Nibfin-Session': session as string,
      });
      check(!ok(badHost.status), 'R9.26', 'Host localhost to be refused', `HTTP ${badHost.status}`);
      const badOrigin = await call(dash.port, 'GET', '/api/commands', {
        Host: host,
        Origin: 'http://evil.example',
        'X-Nibfin-Session': session as string,
      });
      check(!ok(badOrigin.status), 'R9.26', 'a foreign Origin to be refused', `HTTP ${badOrigin.status}`);
      notes.push('proof is one-time; session, Host and Origin are checked');
    } finally {
      await dash.stop();
    }

    // R9.28
    const dist = join(ctx.workDir(), 'gh-nibfin', 'internal', 'dashboard', 'dist');
    check(existsSync(dist), 'R9.28', `the build output at ${dist} (to move it aside)`, 'no such directory');
    const moved = `${dist}.moved-by-e2e`;
    renameSync(dist, moved);
    const restore = async () => {
      if (existsSync(moved) && !existsSync(dist)) renameSync(moved, dist);
    };
    ctx.defer(restore);
    try {
      const path = pathWithoutNode(ctx);
      for (const n of ['gh', 'git', 'podman'])
        check(existsSync(join(path, n)), 'R9.28', `${n} on the Node-less PATH`, 'missing');
      check(!existsSync(join(path, 'node')), 'R9.28', 'node not on the PATH', 'node resolves');
      const bare = await startDashboard(ctx, secrets, { path });
      try {
        const { page } = await openPage(ctx);
        await openDashboard(page, bare);
      } finally {
        await bare.stop();
      }
      notes.push('the three views render with the build folder moved away and no node on PATH');
    } finally {
      await restore();
    }
    return notes.join('; ');
  },
});
