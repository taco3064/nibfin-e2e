import { spawn } from 'node:child_process';
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  /** Adds `GH_TOKEN` (the sandbox token) to the child's environment. Only for `gh`. */
  ghToken?: string;
}

/** Runs one child process from an argv array, never through a shell. */
export type Exec = (argv: string[], options?: ExecOptions) => Promise<ExecResult>;

/** Finds the key a variable is stored under; Windows treats `Path` and `PATH` as one. */
export function envKey(env: Env, name: string, platform = process.platform): string {
  if (platform !== 'win32') return name;
  return Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase()) ?? name;
}

/**
 * The environment a child gets: the host environment without any `E2E_*` secret and
 * without an inherited `GH_TOKEN`; `GH_TOKEN` is set only when the caller passes one.
 */
export function childEnv(env: Env, ghToken?: string): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (upper.startsWith('E2E_') || upper === 'GH_TOKEN') continue;
    out[k] = v;
  }
  if (ghToken !== undefined) out.GH_TOKEN = ghToken;
  return out;
}

/**
 * Node 24 refuses to spawn `.cmd` shims such as Windows' `npm` without a shell, so
 * `npm` runs as `node <npm-cli.js>` there.
 */
export function resolveArgv(argv: string[], env: Env, platform = process.platform, execPath = process.execPath): string[] {
  const [cmd, ...rest] = argv;
  if (cmd !== 'npm' || platform !== 'win32') return argv;
  const cli = env[envKey(env, 'npm_execpath', platform)] ?? join(execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return [execPath, cli, ...rest];
}

/** The real process runner over a host environment that callers may extend (for example `PATH`). */
export function createExec(env: Env, log: (message: string) => void): Exec {
  return (argv, options = {}) =>
    new Promise((resolve, reject) => {
      const [cmd, ...args] = resolveArgv(argv, env);
      if (cmd === undefined) return reject(new Error('exec: empty argv'));
      log(`$ ${argv.join(' ')}${options.cwd ? ` (in ${options.cwd})` : ''}`);
      const child = spawn(cmd, args, {
        cwd: options.cwd,
        env: childEnv(env, options.ghToken),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.on('error', (error) => reject(new Error(`cannot run ${argv[0]}: ${error.message}`)));
      child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(options.input ?? '');
    });
}

/** Throws with the command's own output when it did not exit 0. */
export async function mustRun(exec: Exec, argv: string[], options?: ExecOptions & { hideStdout?: boolean }): Promise<ExecResult> {
  const { hideStdout, ...opts } = options ?? {};
  const r = await exec(argv, opts);
  if (r.code !== 0) {
    const out = (r.stderr.trim() || (hideStdout ? '' : r.stdout.trim())).slice(-4000);
    throw new Error(`${argv.slice(0, 3).join(' ')} exited ${r.code}: ${out}`);
  }
  return r;
}
