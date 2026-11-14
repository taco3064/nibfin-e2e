import { spawn } from 'node:child_process';

// Cleanup callers must preserve resources whenever process-group termination
// could not be confirmed, including errors wrapped by preparation boundaries.
export function sourceTerminationUnknown(error) {
  return error?.terminationUnknown === true ||
    (error?.cause !== undefined && sourceTerminationUnknown(error.cause)) ||
    (Array.isArray(error?.errors) && error.errors.some(sourceTerminationUnknown));
}

// Preparation runs outside scenario workers. A private process group bounds the
// producer and its children; worker termination is never used as process cleanup.
export function sourceCommand(file, args, options = {}) {
  if (process.platform === 'win32') {
    throw new Error('SOURCE_PROCESS_UNSUPPORTED: process-group ownership required');
  }
  const {
    cwd, env, timeoutMs = 600000, limit = 4 * 1024 * 1024, signal: abort,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: [], stderr: [] };
    let size = 0;
    let failure;
    let terminationFailure;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) {
        if (error.code !== 'ESRCH') terminationFailure ??= error;
      }
    };
    const cancel = () => {
      failure ??= new Error('SOURCE_COMMAND_ABORTED');
      stop();
    };
    abort?.addEventListener('abort', cancel, { once: true });
    if (abort?.aborted) cancel();
    const timer = setTimeout(() => {
      failure = new Error('SOURCE_COMMAND_TIMEOUT');
      stop();
    }, timeoutMs);
    child.on('error', error => { failure ??= error; });
    for (const name of Object.keys(output)) {
      child[name].on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          failure ??= new Error('SOURCE_COMMAND_OUTPUT_LIMIT');
          stop();
        } else output[name].push(chunk);
      });
    }
    // Also stop residual children after a producer exits. Await pipe closure
    // before the caller can remove any directory used by the command.
    child.once('exit', stop);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      abort?.removeEventListener('abort', cancel);
      const stdout = Buffer.concat(output.stdout).toString();
      const stderr = Buffer.concat(output.stderr).toString();
      if (terminationFailure) {
        const error = new Error('SOURCE_TERMINATION_UNKNOWN', {
          cause: new AggregateError([failure, terminationFailure].filter(Boolean)),
        });
        error.terminationUnknown = true;
        reject(error);
        return;
      }
      if (failure || code !== 0 || signal) {
        const error = failure ?? new Error(
          `SOURCE_COMMAND_FAILED: ${file} (${signal ?? code}); ${stderr}`,
        );
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}
