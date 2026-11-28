/** What `gh nibfin … --help` (cobra's layout) shows. */
export interface Help {
  /** Names under "Available Commands", without cobra's own `help` and `completion`. */
  commands: string[];
  /** Flags under "Flags" and "Global Flags", without `help`; `default` is the `(default …)` text unquoted. */
  flags: { name: string; default?: string }[];
}

const COBRA_BUILTIN = new Set(['help', 'completion']);

function section(text: string, title: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `${title}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '' || !/^\s/.test(l)) break;
    out.push(l);
  }
  return out;
}

const unquote = (v: string) => (/^".*"$/.test(v) ? v.slice(1, -1) : v);

export function parseHelp(text: string): Help {
  const commands = section(text, 'Available Commands')
    .map((l) => l.trim().split(/\s+/)[0] as string)
    .filter((c) => c && !COBRA_BUILTIN.has(c));
  const flags: Help['flags'] = [];
  for (const l of [...section(text, 'Flags'), ...section(text, 'Global Flags')]) {
    const m = /^\s+(?:-\w,\s+)?--([\w-]+)/.exec(l);
    if (!m || m[1] === 'help') continue;
    const d = /\(default (.+)\)\s*$/.exec(l);
    flags.push(d ? { name: m[1] as string, default: unquote(d[1] as string) } : { name: m[1] as string });
  }
  return { commands, flags };
}

/**
 * The `remaining: <n>` read-back line of `runner remove`: the count, `undefined` when no
 * such line, or an error text when a `remaining:` line is not a whole number.
 */
export function parseRemaining(stdout: string): { count?: number; error?: string } {
  const lines = stdout.split(/\r?\n/).filter((l) => /^\s*remaining:/.test(l));
  if (!lines.length) return {};
  if (lines.length > 1) return { error: `${lines.length} remaining: lines` };
  const m = /^\s*remaining:\s*(\d+)\s*$/.exec(lines[0] as string);
  return m ? { count: Number(m[1]) } : { error: `malformed line "${(lines[0] as string).trim().slice(0, 80)}"` };
}

/** Whether a workflow run's title has the Nibfin prefix and the Issue number as a whole number (Proposal R5.5). */
export function isNibfinRunFor(title: string, issue: number): boolean {
  return title.startsWith('Nibfin') && new RegExp(`(?<!\\d)${issue}(?!\\d)`).test(title);
}

/** Every command's `--help`, from the root down, keyed by its path (`""` for the root, `runner add`, …). */
export async function allHelp(
  run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const visit = async (path: string[]) => {
    const r = await run([...path, '--help']);
    if (r.code !== 0) throw new Error(`gh nibfin ${[...path, '--help'].join(' ')} exited ${r.code}`);
    out.set(path.join(' '), r.stdout + r.stderr);
    for (const sub of parseHelp(r.stdout).commands) await visit([...path, sub]);
  };
  await visit([]);
  return out;
}

/** Runnable commands: those whose help lists no subcommands. */
export function leafCommands(help: Map<string, string>): string[] {
  return [...help].filter(([path, text]) => path !== '' && parseHelp(text).commands.length === 0).map(([path]) => path);
}
