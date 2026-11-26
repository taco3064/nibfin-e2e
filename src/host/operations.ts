import { randomBytes } from 'node:crypto';
import { mustRun } from './exec.ts';
import type { ExecResult } from './exec.ts';
import { writeClaudeToken } from './login.ts';
import { CLAUDE_VOLUME, requireEnv } from './config.ts';
import type { HostServices } from './services.ts';

/** Host operations the lifecycle scenarios use. Linux only: every rule they verify is mapped for `linux`. */
export interface HostOperations {
  /** Writes the real Claude token (`valid`) or a random non-secret string (`invalid`) into the login volume, read back. */
  claudeLogin(state: 'valid' | 'invalid'): Promise<string>;
  /** Stops or starts every `nibfin-runner-claude-*` systemd user service and reads each back; returns the unit names. */
  runnerServices(action: 'stop' | 'start'): Promise<string[]>;
  /** Stops the Job containers of one Issue (by the Podman labels Nibfin sets) and reads back that none is left; returns how many were stopped. */
  stopJobContainers(repo: string, issue: number): Promise<number>;
  /** The secret values, for in-memory absence checks only. Never print them. */
  secretValues(): string[];
  /** The sandbox token's login and user id (`GET /user`), cached. */
  ownerLogin(): Promise<string>;
  ownerId(): Promise<number>;
}

/** The Podman labels Nibfin puts on Job containers. */
export const JOB_LABELS = { repo: 'io.github.taco3064.nibfin.repo', issue: 'io.github.taco3064.nibfin.issue' } as const;

const UNITS = 'nibfin-runner-claude-*.service';

/** Unit names from `systemctl list-units --plain --no-legend` output (the first column). */
export function parseUnits(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((u) => /^nibfin-runner-claude-[\w.-]+\.service$/.test(u));
}

export function createHostOperations(host: HostServices, platform: string = process.platform): HostOperations {
  const linuxOnly = (what: string) => {
    if (platform !== 'linux') throw new Error(`${what} is not supported on ${platform}`);
  };
  const { exec } = host;
  let user: Promise<{ login: string; id: number }> | undefined;
  const me = () =>
    (user ??= host.github.rest<{ login: string; id: number }>('GET', '/user').then(
      (r) => r.data,
      (error: unknown) => {
        user = undefined;
        throw error;
      },
    ));

  const systemctl = (args: string[]): Promise<ExecResult> => {
    // `systemctl --user` needs the user manager's runtime directory; a hosted job's
    // shell may not set it. `runner add` enabled linger, so the manager is running.
    if (!host.env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') host.env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
    return exec(['systemctl', '--user', ...args]);
  };

  return {
    async claudeLogin(state) {
      linuxOnly('claudeLogin');
      const token = state === 'valid' ? requireEnv(host.env, 'E2E_CLAUDE_TOKEN') : `e2e-invalid-${randomBytes(12).toString('hex')}`;
      const done = await writeClaudeToken(host, token, { manageMachine: false });
      return state === 'valid' ? done : `${CLAUDE_VOLUME}/settings.json holds a random invalid token (read back)`;
    },

    async runnerServices(action) {
      linuxOnly('runnerServices');
      const listed = await systemctl(['list-units', '--all', '--plain', '--no-legend', UNITS]);
      if (listed.code !== 0) throw new Error(`systemctl --user list-units exited ${listed.code}: ${(listed.stderr || listed.stdout).trim().slice(-2000)}`);
      const units = parseUnits(listed.stdout);
      if (!units.length) throw new Error(`no ${UNITS} unit is loaded in the user manager`);
      for (const unit of units) {
        const r = await systemctl([action, unit]);
        if (r.code !== 0) throw new Error(`systemctl --user ${action} ${unit} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
      }
      const want = action === 'start' ? ['active'] : ['inactive', 'failed'];
      const wrong: string[] = [];
      for (const unit of units) {
        const state = (await systemctl(['is-active', unit])).stdout.trim();
        if (!want.includes(state)) wrong.push(`${unit} is ${state || 'unknown'}`);
      }
      if (wrong.length) throw new Error(`after systemctl --user ${action}: ${wrong.join('; ')}`);
      return units;
    },

    async stopJobContainers(repo, issue) {
      linuxOnly('stopJobContainers');
      // The repo label may hold the full name or only the repository name.
      const names = new Set([repo, repo.split('/')[1] ?? repo]);
      const list = async () => {
        const r = await mustRun(exec, ['podman', 'ps', '--filter', `label=${JOB_LABELS.issue}=${issue}`, '--format', 'json']);
        const items = JSON.parse(r.stdout.trim() || '[]') as { Id: string; Labels?: Record<string, string> | null }[];
        return items.filter((c) => names.has(c.Labels?.[JOB_LABELS.repo] ?? '')).map((c) => c.Id);
      };
      const ids = await list();
      for (const id of ids) await mustRun(exec, ['podman', 'stop', '--time', '0', id]);
      const left = await list();
      if (left.length) throw new Error(`${left.length} Job container(s) of ${repo}#${issue} are still running after podman stop`);
      return ids.length;
    },

    secretValues() {
      const out: string[] = [];
      for (const name of ['E2E_SANDBOX_TOKEN', 'E2E_CLAUDE_TOKEN'] as const) {
        const v = host.env[name]?.trim();
        if (v) out.push(v);
      }
      return out;
    },

    ownerLogin: async () => (await me()).login,
    ownerId: async () => (await me()).id,
  };
}
