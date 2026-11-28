import type { Env, ExecResult } from '../../src/host/exec.ts';
import type { GitHub } from '../../src/host/github.ts';
import { userRuntimeDir } from '../../src/host/hoststate.ts';

/**
 * The Runner slot (`claude-<n>`, its directory and service name) of a registration.
 * gh-nibfin names registrations `<hostname>-<hostid>-<slot>`, so only the suffix is fixed.
 */
export function runnerSlot(registrationName: string): string | undefined {
  return /-(claude-[1-9][0-9]*)$/.exec(registrationName)?.[1];
}

export interface LocalRunner {
  slot: string;
  name: string;
  status: string;
  busy: boolean;
}

/** The slots `runner add claude --count <count>` creates: claude-1 … claude-<count>. */
export function slotsOf(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `claude-${i + 1}`);
}

/**
 * This host's Runners, read from the execution sandbox (Runners register only there).
 * The pre-run reset deleted every registration before `runner add`, so exactly the slots
 * claude-1 … claude-<count> must be present, where `count` is what the `nibfin` step
 * added; any other set fails, naming the count and listing what was seen.
 */
export async function localRunners(gh: GitHub, execution: string, count: number): Promise<LocalRunner[]> {
  const all = await gh.list<{ name: string; status: string; busy?: boolean }>(
    `/repos/${execution}/actions/runners`,
    'runners',
  );
  const seen = () => all.map((r) => `${r.name} (${r.status}${r.busy ? ', busy' : ''})`).join(', ') || 'none';
  const out: LocalRunner[] = all.map((r) => ({
    slot: runnerSlot(r.name) ?? '',
    name: r.name,
    status: r.status,
    busy: r.busy === true,
  }));
  const want = slotsOf(count);
  const slots = out.map((r) => r.slot).sort();
  if (out.length !== want.length || slots.join(' ') !== [...want].sort().join(' ')) {
    throw new Error(
      `${execution}: expected exactly ${count} runner registrations ending in ${want.map((w) => `-${w}`).join(', ')}; saw ${seen()}`,
    );
  }
  return out.sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));
}

const slotNumber = (slot: string) => Number(slot.slice('claude-'.length));

/**
 * Stops or starts the systemd user services of the given Runner slots
 * (`nibfin-runner-<slot>.service`) and reads each back with `is-active`, so a scenario can run
 * with fewer active Runners than the host has. `systemctl --user` needs the user manager's
 * runtime directory, which a hosted job's shell may not set, so it is passed explicitly.
 * A failed command or a unit in the wrong state afterwards throws naming the unit.
 */
export async function setSlotServices(
  exec: (argv: string[], options?: { env?: Record<string, string> }) => Promise<ExecResult>,
  env: Env,
  action: 'stop' | 'start',
  slots: string[],
): Promise<void> {
  const runtime = userRuntimeDir(env);
  const options = runtime === undefined ? {} : { env: { XDG_RUNTIME_DIR: runtime } };
  const units = slots.map((slot) => `nibfin-runner-${slot}.service`);
  for (const unit of units) {
    const r = await exec(['systemctl', '--user', action, unit], options);
    if (r.code !== 0)
      throw new Error(`systemctl --user ${action} ${unit} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-1000)}`);
  }
  const want = action === 'start' ? ['active'] : ['inactive', 'failed'];
  const wrong: string[] = [];
  for (const unit of units) {
    const r = await exec(['systemctl', '--user', 'is-active', unit], options);
    const state = r.stdout.trim() || `unknown (exit ${r.code})`;
    if (!want.includes(state)) wrong.push(`${unit} is ${state}`);
  }
  if (wrong.length) throw new Error(`after systemctl --user ${action}: ${wrong.join('; ')}`);
}

/** The problem naming every Runner that is not online and idle, or undefined when all are. */
export function idleProblem(runners: LocalRunner[]): string | undefined {
  const bad = runners.filter((r) => r.status !== 'online' || r.busy);
  if (!bad.length) return undefined;
  return `Runners not online and idle: ${bad.map((r) => `${r.slot} (registration ${r.name}) is ${r.status}${r.busy ? ' and busy' : ''}`).join('; ')}`;
}
