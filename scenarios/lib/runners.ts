import type { GitHub } from '../../src/host/github.ts';

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

export const SLOTS = ['claude-1', 'claude-2'] as const;

/**
 * This host's two Runners, read from the execution sandbox (Runners register only there).
 * The pre-run reset deleted every registration before `runner add`, so exactly the slots
 * claude-1 and claude-2 must be present; any other set fails and lists what was seen.
 */
export async function localRunners(gh: GitHub, execution: string): Promise<LocalRunner[]> {
  const all = await gh.list<{ name: string; status: string; busy?: boolean }>(`/repos/${execution}/actions/runners`, 'runners');
  const seen = () => all.map((r) => `${r.name} (${r.status}${r.busy ? ', busy' : ''})`).join(', ') || 'none';
  const out: LocalRunner[] = all.map((r) => ({ slot: runnerSlot(r.name) ?? '', name: r.name, status: r.status, busy: r.busy === true }));
  const slots = out.map((r) => r.slot).sort();
  if (out.length !== SLOTS.length || slots.join(' ') !== [...SLOTS].join(' ')) {
    throw new Error(`${execution}: expected exactly two runner registrations ending in -claude-1 and -claude-2; saw ${seen()}`);
  }
  return out.sort((a, b) => (a.slot < b.slot ? -1 : 1));
}

/** Throws naming every Runner that is not online and idle. */
export function requireIdle(runners: LocalRunner[]): void {
  const bad = runners.filter((r) => r.status !== 'online' || r.busy);
  if (bad.length) {
    throw new Error(`Runners not online and idle: ${bad.map((r) => `${r.slot} (registration ${r.name}) is ${r.status}${r.busy ? ' and busy' : ''}`).join('; ')}`);
  }
}
