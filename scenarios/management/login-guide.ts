// Reading the CLI's login guide from streamed `gh nibfin runner add` output (Proposal R5.30).
// Without a terminal, gh-nibfin prints each login step as its own stderr line:
// `open <URL>` for the sign-in URL and `enter code <CODE>` for a device code.
// `gh nibfin login <provider>` (Proposal R5.34) prints the same step lines, and Claude's adds
// the prompt `paste the code shown in your browser: `.
import type { Running } from '../../src/host/exec.ts';
import type { RunContext } from '../../src/types.ts';
import { redact as redactSecrets } from '../dashboard/checks.ts';
import { redact as redactTokens, tail } from '../lib/check.ts';

/** The CLI's sign-in step line; it alone counts as the login guide. */
export const GUIDE_LINE = /^\s*open (https:\/\/\S+)\s*$/m;
/** The CLI's device-code step line; optional evidence. */
export const CODE_LINE = /^\s*enter code (\S+)\s*$/m;
/** The CLI's prompt for the code shown in the browser (Claude); optional evidence. */
export const PASTE_PROMPT = /paste the code shown in your browser/;
/** A line that claims a finished login (used only to word a failure); "not logged in" is not one. */
export const SUCCESS_LINE = /(?<!not )\b(logged in|login (succeeded|complete|finished))\b/i;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** CSI sequences (colours, cursor moves), OSC sequences (titles, links) and other two-byte escapes. */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-_]`, 'g');
const URL_TOKEN = /https:\/\/\S+/g;
const CODE_TOKEN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** Output lines without ANSI escapes, split on `\r` and `\n`. */
export const lines = (output: string): string[] => stripAnsi(output).split(/\r\n|\r|\n/);

function githubHost(raw: string): boolean {
  try {
    const host = new URL(raw.replace(/[)\]}>.,;:'"`]+$/, '')).hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

export interface LoginGuide {
  /** From the first `open <URL>` step line. */
  url?: string;
  /** From the first `enter code <CODE>` step line. */
  code?: string;
  /** Every value to keep out of reasons and logs, longest first. */
  secrets: string[];
}

export function loginGuide(output: string): LoginGuide {
  let url: string | undefined;
  let code: string | undefined;
  const secrets = new Set<string>();
  const one = (re: RegExp, line: string) => new RegExp(re.source, re.flags.replace('m', '')).exec(line)?.[1];
  for (const line of lines(output)) {
    const u = one(GUIDE_LINE, line);
    if (u) {
      url ??= u;
      secrets.add(u);
    }
    const c = one(CODE_LINE, line);
    if (c) {
      code ??= c;
      secrets.add(c);
    }
    for (const m of line.matchAll(URL_TOKEN)) if (!githubHost(m[0])) secrets.add(m[0]);
    for (const m of line.matchAll(CODE_TOKEN)) secrets.add(m[0]);
  }
  return { url, code, secrets: [...secrets].sort((a, b) => b.length - a.length) };
}

/**
 * The end of the output for a reason: ANSI stripped, every login value and token hidden
 * across the whole output before it is cut, so a cut never leaves part of a secret.
 */
export function guideTail(output: string, max = 800): string {
  const text = redactTokens(redactSecrets(stripAnsi(output), loginGuide(output).secrets)).trim();
  return text.length > max ? '…' + text.slice(-max) : text;
}

export type WaitEnd = 'found' | 'exited' | 'timeout' | 'aborted';

/**
 * Polls the child's output until `find` returns a value, the child exits, the deadline
 * passes or `signal` aborts. Never resolves `found` without a value.
 */
export async function waitForOutput<T>(
  child: Pick<Running, 'output' | 'waitFor'>,
  find: (output: string) => T | undefined,
  timeoutMs: number,
  opts: { pollMs?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<{ end: WaitEnd; value?: T }> {
  const now = opts.now ?? Date.now;
  const start = now();
  const deadline = start + timeoutMs;
  let exited = false;
  // A pattern that never matches: waitFor rejects only when the child exits (or at its own
  // later timeout, which an earlier deadline below makes irrelevant).
  child.waitFor(/(?!)/, timeoutMs + 60_000).catch(() => {
    if (now() < deadline) exited = true;
  });
  for (;;) {
    const value = find(child.output());
    if (value !== undefined) return { end: 'found', value };
    if (exited) {
      // Output that arrived with the exit still counts.
      const last = find(child.output());
      return last === undefined ? { end: 'exited' } : { end: 'found', value: last };
    }
    if (opts.signal?.aborted) return { end: 'aborted' };
    if (now() >= deadline) return { end: 'timeout' };
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(opts.pollMs ?? 500, deadline - now()))));
  }
}

/**
 * Local Runners of `provider` that `status --json` lists under `.host.runners.runners`
 * (null when there are none); undefined when the status has no such list to read.
 */
export function statusRunners(status: unknown, provider: string): unknown[] | undefined {
  const list = (status as { host?: { runners?: { runners?: unknown } | null } | null } | null)?.host?.runners?.runners;
  if (list === null) return [];
  if (!Array.isArray(list)) return undefined;
  return list.filter((r) => (r as { provider?: unknown } | null)?.provider === provider);
}

/**
 * Reads `gh nibfin login <provider>` output for Proposal R5.34's refusal. `guide` is true when
 * a sign-in step line or the paste prompt appeared; `refused` when the command exited
 * non-zero, some line names the missing Runner of `provider` (or `runner add <provider>`)
 * and no guide appeared.
 */
export function loginRefusal(code: number, output: string, provider: string): { refused: boolean; guide: boolean } {
  const all = lines(output);
  const guide = loginGuide(output).url !== undefined || all.some((l) => PASTE_PROMPT.test(l));
  const p = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new RegExp(`\\bno ${p} runners?\\b|\\brunner add ${p}\\b`, 'i');
  return { refused: code !== 0 && !guide && all.some((l) => names.test(l)), guide };
}

/** `podman volume exists`: true, false, or throws on another error (exit 125). */
export async function volumeExists(ctx: Pick<RunContext, 'exec'>, volume: string): Promise<boolean> {
  const r = await ctx.exec(['podman', 'volume', 'exists', volume]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`podman volume exists ${volume} exited ${r.code}: ${tail(r, 300)}`);
}

/** IDs of every container (running or not) that mounts `volume`. */
export async function volumeContainers(ctx: Pick<RunContext, 'exec'>, volume: string): Promise<string[]> {
  const r = await ctx.exec(['podman', 'ps', '-a', '--filter', `volume=${volume}`, '--format', '{{.ID}}']);
  if (r.code !== 0) throw new Error(`podman ps -a --filter volume=${volume} exited ${r.code}: ${tail(r, 300)}`);
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
