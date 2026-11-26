import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireEnv } from './config.ts';
import { createExec } from './exec.ts';
import type { Env, Exec } from './exec.ts';
import { createGitHub } from './github.ts';
import type { GitHub } from './github.ts';

/** What the host steps use to reach the machine and GitHub. Tests replace each part. */
export interface HostServices {
  /** The host environment children inherit (minus `E2E_*`); steps may extend `PATH`. */
  env: Env;
  exec: Exec;
  fetch: typeof fetch;
  github: GitHub;
  repoRoot: string;
  /** `<repo root>/.e2e-work/`: deleted and recreated on first use in this process. */
  workDir(): string;
  sandboxToken(): string;
}

export function createServices(repoRoot: string, log: (message: string) => void, env: Env = { ...process.env }): HostServices {
  let fresh = false;
  const sandboxToken = () => requireEnv(env, 'E2E_SANDBOX_TOKEN');
  return {
    env,
    exec: createExec(env, log),
    fetch,
    github: createGitHub(sandboxToken),
    repoRoot,
    workDir() {
      const dir = join(repoRoot, '.e2e-work');
      if (!fresh) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        fresh = true;
      }
      return dir;
    },
    sandboxToken,
  };
}
