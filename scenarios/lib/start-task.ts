import type { TaskDetail } from '../../src/host/hoststate.ts';

// The one match for the scheduled task that runs `podman machine start` (Proposal R5.13).
// runner-add-setup (R5.13), podman-machine-detached (R5.12), runner-remove (R5.16) and the
// provisioning record all use it, so they agree on which task is the start task.

/** `machine start` as podman's subcommand, at the start of the text that follows the program. */
const MACHINE_START = /^\s+machine\s+start\b/;
/** A podman program token, quoted or not, with any path: the name starts the text or follows a space, quote or path separator. */
const PODMAN_TOKEN = /(?:^|[\s"\\/])podman(?:\.exe)?"?/gi;
/** conhost's `--headless` flag as a token of its own. */
const HEADLESS = /(?:^|\s)--headless(?=\s|$)/;

/** The lowercased file name of a task action's program: quotes and the directory are dropped. */
function programName(execute: string): string {
  const bare = execute.trim().replace(/^"(.*)"$/, '$1');
  return bare.slice(Math.max(bare.lastIndexOf('\\'), bare.lastIndexOf('/')) + 1).toLowerCase();
}

/** Some podman program token in `text` is followed by `machine start`. */
function podmanStartsIn(text: string): boolean {
  for (const m of text.matchAll(PODMAN_TOKEN)) {
    if (MACHINE_START.test(text.slice(m.index + m[0].length))) return true;
  }
  return false;
}

/**
 * The action runs `podman machine start`: either podman itself is the program, or the
 * program is conhost with `--headless` and, somewhere after that flag, a podman program
 * followed by `machine start`. The podman program is matched by its whole file name, so
 * `notpodman.exe` is not podman. Other subcommands and other programs do not match.
 */
export function startsMachine(action: { execute: string; arguments: string }): boolean {
  const name = programName(action.execute);
  if (name === 'podman' || name === 'podman.exe') return /\bmachine\s+start\b/.test(action.arguments);
  if (name !== 'conhost' && name !== 'conhost.exe') return false;
  const headless = HEADLESS.exec(action.arguments);
  return !!headless && podmanStartsIn(action.arguments.slice(headless.index + headless[0].length));
}

/** The first task with an action that runs `podman machine start`. */
export function startTask(details: { t: string; d: TaskDetail }[]): { t: string; d: TaskDetail } | undefined {
  return details.find(({ d }) => d.actions.some(startsMachine));
}
