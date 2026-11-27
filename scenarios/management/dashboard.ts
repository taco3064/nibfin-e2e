import type { Running } from '../../src/host/exec.ts';
import type { Scenario } from '../../src/types.ts';
import { redact } from '../dashboard/checks.ts';
import { Check, message, tail } from '../lib/check.ts';
import { allHelp, leafCommands, parseHelp } from '../lib/gh.ts';
import { json } from '../lib/github.ts';
import { statusValidator } from '../lib/schema.ts';

interface ApiCommand {
  path: string;
  api?: string;
  flags?: { name: string; default?: unknown }[];
}

/** cobra prints no `(default …)` for zero values, so those compare as empty. */
export function normalDefault(v: unknown): string {
  if (v === undefined || v === null || v === '' || v === false || v === 0 || v === 'false' || v === '0' || v === '[]') return '';
  if (Array.isArray(v)) return v.length ? `[${v.join(',')}]` : '';
  return String(v);
}

/** Differences between a command's `--help` flags and its `/api/commands` flags (Proposal R5.23). */
export function flagDiff(helpText: string, api: ApiCommand): string[] {
  const help = parseHelp(helpText).flags;
  const apiFlags = (api.flags ?? []).filter((f) => f.name !== 'help');
  const out: string[] = [];
  const names = (l: { name: string }[]) => l.map((f) => f.name).sort().join(', ');
  if (names(help) !== names(apiFlags)) out.push(`flags in --help [${names(help)}] differ from /api/commands [${names(apiFlags)}]`);
  for (const f of help) {
    const a = apiFlags.find((x) => x.name === f.name);
    if (a && normalDefault(f.default) !== normalDefault(a.default)) {
      out.push(`--${f.name} default is ${JSON.stringify(f.default ?? '')} in --help and ${JSON.stringify(a.default ?? '')} in /api/commands`);
    }
  }
  return out;
}

/**
 * The Dashboard session URL with a proof in its fragment (Proposal R9.26), whatever text precedes it
 * on the same line or an earlier one. The host is captured as printed, so a wrong address fails R5.53 by name.
 */
export const SESSION_URL = /http:\/\/(\[[^\]\s]+\]|[^/:\s]+):(\d+)\/\S*#\S*proof=\S+/;

export interface SessionAddress {
  host: string;
  port: number;
  /** `http://<host>:<port>`, without path or fragment, safe for messages. */
  origin: string;
  proof: string;
}

/** Reads the first session URL in `text`; undefined when there is none or its fragment has no proof. */
export function sessionAddress(text: string): SessionAddress | undefined {
  const m = SESSION_URL.exec(text);
  if (!m) return undefined;
  let proof: string | null;
  try {
    proof = new URLSearchParams(new URL(m[0]).hash.slice(1)).get('proof');
  } catch {
    return undefined;
  }
  if (!proof) return undefined;
  const host = m[1] as string;
  const port = Number(m[2]);
  return { host, port, origin: `http://${host}:${port}`, proof };
}

export const dashboard: Scenario = {
  id: 'dashboard',
  rules: ['R5.20', 'R5.23', 'R5.53'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const validate = statusValidator(ctx.workPath('gh-nibfin'));
    const help = await allHelp((args) => ctx.ghNibfin(args));
    const commands = leafCommands(help).filter((p) => p !== 'dashboard');
    const status = await ctx.ghNibfin(['status', '--json']);
    const statusKeys = Object.keys(json<Record<string, unknown>>(status.stdout, 'status --json')).sort();

    let server: Running | undefined;
    let proof: string | undefined;
    try {
      // The run also registers the child's stop(), so it ends even when this scenario is cut short.
      server = ctx.startGhNibfin(['dashboard', '--no-browser']);
      const m = await server.waitFor(SESSION_URL, 90_000);
      const address = sessionAddress(m[0]);
      if (!address) {
        c.fail('R5.53', 'the Dashboard printed a session URL without a readable proof in its fragment');
        return c.outcome('');
      }
      proof = address.proof;
      if (!c.that(address.host === '127.0.0.1', 'R5.53', `the Dashboard address is ${address.origin}/, expected http://127.0.0.1:<port>/`)) {
        return c.outcome('');
      }
      const base = address.origin;

      const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
        const res = await fetch(base + path, {
          method,
          headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`Dashboard ${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text) as unknown;
      };
      const { session } = (await call('POST', '/api/session', { 'X-Nibfin-Proof': proof })) as { session?: string };
      if (!session) return { status: 'failed', reason: 'R5.53: the Dashboard returned no session for the printed proof' };
      const auth = { 'X-Nibfin-Session': session };

      const api = ((await call('GET', '/api/commands', auth)) as { commands?: ApiCommand[] }).commands ?? [];
      for (const path of commands) {
        const entry = api.find((a) => a.path === path);
        if (!c.that(!!entry && typeof entry.api === 'string' && entry.api !== '', 'R5.20', `the Dashboard has no operation for gh nibfin ${path}`) || !entry) continue;
        for (const d of flagDiff(help.get(path) ?? '', entry)) c.fail('R5.23', `${path}: ${d}`);
      }

      const planned = (await call('POST', '/api/commands/status/plan', auth, { repo: '' })) as { result?: unknown };
      const errors = validate(planned.result);
      c.that(!errors.length, 'R5.20', `the Dashboard status result does not match status.schema.json: ${errors.join('; ')}`);
      const keys = Object.keys((planned.result ?? {}) as object).sort();
      c.that(keys.join(',') === statusKeys.join(','), 'R5.20', `the Dashboard status result has keys [${keys.join(', ')}], status --json [${statusKeys.join(', ')}]`);
    } catch (error) {
      const detail = `${message(error)}${server ? ` (server output: ${tail({ stdout: server.output(), stderr: '' }, 300)})` : ''}`;
      c.fail('R5.20', redact(detail, proof ? [proof] : []));
    } finally {
      await server?.stop();
    }
    return c.outcome(`the Dashboard on 127.0.0.1 offers all ${commands.length} commands with the CLI's flags, and its status matches status --json`);
  },
};
