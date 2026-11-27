import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
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
  /**
   * Extra variables set after the filter (for example `PATH` or `XDG_DATA_HOME`). A key
   * that is `GH_TOKEN` or starts with `E2E_` throws, so the credential rule holds.
   */
  env?: Record<string, string>;
}

/** Runs one child process from an argv array, never through a shell. */
export type Exec = (argv: string[], options?: ExecOptions) => Promise<ExecResult>;

/** Finds the key a variable is stored under; Windows treats `Path` and `PATH` as one. */
export function envKey(env: Env, name: string, platform = process.platform): string {
  if (platform !== 'win32') return name;
  return Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase()) ?? name;
}

/**
 * The environment a child gets: the host environment without any `E2E_*` secret, without
 * the Owner's `NIBFIN_GITHUB_TOKEN` and without an inherited `GH_TOKEN`; `GH_TOKEN` is set
 * only when the caller passes one.
 */
export function childEnv(env: Env, ghToken?: string, extra: Record<string, string> = {}, platform = process.platform): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (upper.startsWith('E2E_') || upper === 'GH_TOKEN' || upper === 'NIBFIN_GITHUB_TOKEN') continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    const upper = k.toUpperCase();
    if (upper.startsWith('E2E_') || upper === 'GH_TOKEN') throw new Error(`exec: the variable ${k} cannot be set for a child`);
    out[envKey(out, k, platform)] = v;
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
      let childVars: Env;
      try {
        childVars = childEnv(env, options.ghToken, options.env);
      } catch (error) {
        return reject(error);
      }
      log(`$ ${argv.join(' ')}${options.cwd ? ` (in ${options.cwd})` : ''}`);
      const child = spawn(cmd, args, {
        cwd: options.cwd,
        env: childVars,
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

/** A long-running child whose stdout arrives line by line. */
export interface Streaming {
  /** Kills the child; safe to call more than once. */
  stop(): void;
  /** Settles with the exit code once the child has ended (also after `stop`). */
  closed: Promise<number>;
}

/** Starts a long-running child (for example `podman events`) from an argv array, never through a shell. */
export type Stream = (argv: string[], onLine: (line: string) => void) => Streaming;

/** The real streaming runner; the child gets the same filtered environment as `createExec`'s children. */
export function createStream(env: Env, log: (message: string) => void): Stream {
  return (argv, onLine) => {
    const [cmd, ...args] = resolveArgv(argv, env);
    if (cmd === undefined) throw new Error('stream: empty argv');
    log(`$ ${argv.join(' ')} (streaming)`);
    const child = spawn(cmd, args, { env: childEnv(env), shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let rest = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    });
    child.stderr.resume();
    const closed = new Promise<number>((resolve) => {
      child.on('error', () => resolve(127));
      child.on('close', (code, signal) => {
        if (rest.trim()) onLine(rest);
        resolve(code ?? (signal ? 128 : 1));
      });
    });
    return {
      stop: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
      closed,
    };
  };
}

export interface StartOptions {
  cwd?: string;
  /** Adds `GH_TOKEN` (the sandbox token) to the child's environment. Only for `gh`. */
  ghToken?: string;
  /** Replaces the child's `PATH`. */
  path?: string;
  /** How long `stop()` waits after SIGTERM before SIGKILL (default 5 s). */
  graceMs?: number;
  /** How long `stop()` waits for `close` after SIGKILL (default 5 s). */
  closeMs?: number;
}

/** A child process that runs alongside the caller, for example a server. */
export interface Running {
  /** Everything the child wrote to stdout and stderr so far, interleaved. */
  output(): string;
  /** Resolves with the first match in the output, or rejects with the output's tail after `timeoutMs`. */
  waitFor(pattern: RegExp, timeoutMs: number): Promise<RegExpExecArray>;
  /**
   * Idempotent. SIGTERM to the child's process group, then SIGKILL after the grace period,
   * then waits for `close` up to a bound. Always destroys the child's stdio and unrefs it, so the child cannot
   * keep this process alive even when it ignored both signals.
   */
  stop(): Promise<ExecResult>;
}

/** Starts one long-lived child from an argv array, never through a shell, with the same environment rules as `Exec`. */
export type Start = (argv: string[], options?: StartOptions) => Running;

/** The part of `spawn` that `createStart` uses; tests replace it. */
export type SpawnFn = (cmd: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams;

const tailOf = (text: string) => text.slice(-2000);

export function createStart(env: Env, log: (message: string) => void, spawnFn: SpawnFn = spawn as unknown as SpawnFn): Start {
  return (argv, options = {}) => {
    const [cmd, ...args] = resolveArgv(argv, env);
    if (cmd === undefined) throw new Error('start: empty argv');
    log(`$ ${argv.join(' ')} &${options.cwd ? ` (in ${options.cwd})` : ''}`);
    const base = childEnv(env, options.ghToken);
    const childEnvironment: Env = {};
    for (const [k, v] of Object.entries(base)) if (options.path === undefined || k.toUpperCase() !== 'PATH') childEnvironment[k] = v;
    if (options.path !== undefined) childEnvironment[envKey(env, 'PATH')] = options.path;
    // Its own process group, so stop() also reaches what it starts: `gh` runs an extension
    // as a child and does not pass signals on.
    const group = process.platform !== 'win32';
    const child = spawnFn(cmd, args, { cwd: options.cwd, env: childEnvironment, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: group });
    const signal = (sig: NodeJS.Signals) => {
      if (group && child.pid !== undefined) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // the group is gone; fall back to the child itself
        }
      }
      child.kill(sig);
    };
    let stdout = '';
    let stderr = '';
    let all = '';
    let closed: { code: number } | undefined;
    let spawnError: string | undefined;
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const l of [...listeners]) l();
    };
    const closeWaiters = new Set<() => void>();
    child.stdout.setEncoding('utf8').on('data', (d: string) => ((stdout += d), (all += d), notify()));
    child.stderr.setEncoding('utf8').on('data', (d: string) => ((stderr += d), (all += d), notify()));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      spawnError = `cannot run ${argv[0]}: ${error.message}`;
      notify();
    });
    child.on('close', (code, signal) => {
      closed = { code: code ?? (signal ? 128 : 1) };
      notify();
      for (const w of [...closeWaiters]) w();
    });

    const waitClose = (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (closed || spawnError) return resolve(true);
        const done = () => {
          clearTimeout(timer);
          closeWaiters.delete(done);
          resolve(true);
        };
        const timer = setTimeout(() => {
          closeWaiters.delete(done);
          resolve(false);
        }, ms);
        closeWaiters.add(done);
      });

    let stopping: Promise<ExecResult> | undefined;
    const running: Running = {
      output: () => all,
      waitFor(pattern, timeoutMs) {
        return new Promise((resolve, reject) => {
          const check = () => {
            const m = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(all);
            if (m) return finish(() => resolve(m));
            if (spawnError) return finish(() => reject(new Error(spawnError)));
            if (closed) return finish(() => reject(new Error(`${argv.slice(0, 3).join(' ')} exited ${closed?.code} before printing ${pattern}: ${tailOf(all)}`)));
          };
          const timer = setTimeout(() => finish(() => reject(new Error(`${argv.slice(0, 3).join(' ')} printed no ${pattern} within ${timeoutMs} ms: ${tailOf(all)}`))), timeoutMs);
          const finish = (fn: () => void) => {
            clearTimeout(timer);
            listeners.delete(check);
            fn();
          };
          listeners.add(check);
          check();
        });
      },
      stop() {
        stopping ??= (async () => {
          if (!closed && !spawnError) {
            signal('SIGTERM');
            if (!(await waitClose(options.graceMs ?? 5000))) {
              signal('SIGKILL');
              await waitClose(options.closeMs ?? 5000);
            }
          }
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          return { code: closed?.code ?? 137, stdout, stderr };
        })();
        return stopping;
      },
    };
    return running;
  };
}
