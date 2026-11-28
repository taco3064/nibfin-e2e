import type { Exec, ExecResult } from '../../src/host/exec.ts';
import { tail } from './check.ts';

/** POSIX single-quoting: the text is one shell word with nothing expanded. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A host command's result; a program that cannot start gives exit -1 with the reason. */
export async function tryExec(exec: Exec, argv: string[], options?: Parameters<Exec>[1]): Promise<ExecResult> {
  try {
    return await exec(argv, options);
  } catch (error) {
    return { code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

export interface Machine {
  name: string;
  state: string;
}

/** `podman machine inspect`'s `[0].Name` and `[0].State`; throws naming the command and its output when either cannot be read. */
export async function readMachine(exec: Exec): Promise<Machine> {
  const r = await tryExec(exec, ['podman', 'machine', 'inspect']);
  if (r.code !== 0) throw new Error(`podman machine inspect exited ${r.code}: ${tail(r)}`);
  let first: { Name?: unknown; State?: unknown } | undefined;
  try {
    const v: unknown = JSON.parse(r.stdout);
    first = Array.isArray(v) ? (v[0] as typeof first) : undefined;
  } catch {
    throw new Error(`podman machine inspect did not print JSON: ${tail(r, 200)}`);
  }
  if (typeof first?.Name !== 'string' || !first.Name)
    throw new Error(`podman machine inspect reports no Name: ${tail(r, 200)}`);
  return { name: first.Name, state: typeof first.State === 'string' ? first.State : '' };
}

/**
 * Runs `script` inside the machine's VM: `podman machine ssh <machine> <script>`. The machine
 * name is always given so the script is never taken for one, and the script is one argument.
 * A non-zero exit throws with the end of the output.
 */
export async function vmExec(exec: Exec, machine: string, script: string): Promise<string> {
  const r = await tryExec(exec, ['podman', 'machine', 'ssh', machine, script]);
  if (r.code !== 0) throw new Error(`podman machine ssh ${machine} … exited ${r.code}: ${tail(r)}`);
  return r.stdout;
}
