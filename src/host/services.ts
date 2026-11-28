import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireEnv } from './config.ts';
import { createExec, createStart } from './exec.ts';
import type { Env, Exec, Start } from './exec.ts';
import { createGitHub } from './github.ts';
import type { GitHub } from './github.ts';
import type { PeerHandle } from './peer.ts';

/** What the host steps use to reach the machine and GitHub. Tests replace each part. */
export interface HostServices {
  /** The host environment children inherit (minus `E2E_*`); steps may extend `PATH`. */
  env: Env;
  exec: Exec;
  /** Starts a long-lived child with the same environment rules as `exec`. */
  start: Start;
  fetch: typeof fetch;
  github: GitHub;
  repoRoot: string;
  /** `<repo root>/.e2e-work/`: deleted and recreated on first use in this process. */
  workDir(): string;
  sandboxToken(): string;
  /** GitHub REST as the collaborator account (`E2E_PEER_GITHUB_TOKEN`): its own SSH keys and the `review-events` PR reviews. */
  peerGithub: GitHub;
  peerToken(): string;
  /** Set by the `collaborator` step once the peer user is ready. */
  peer?: PeerHandle;
}

export function createServices(
  repoRoot: string,
  log: (message: string) => void,
  env: Env = { ...process.env },
): HostServices {
  let fresh = false;
  const sandboxToken = () => requireEnv(env, 'E2E_SANDBOX_TOKEN');
  const peerToken = () => requireEnv(env, 'E2E_PEER_GITHUB_TOKEN');
  return {
    env,
    exec: createExec(env, log),
    start: createStart(env, log),
    fetch,
    github: createGitHub(sandboxToken, fetch, undefined, { log }),
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
    peerGithub: createGitHub(peerToken, fetch, undefined, { log }),
    peerToken,
  };
}
