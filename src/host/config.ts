import type { Env } from './exec.ts';

/** The two fixed sandboxes (Proposal R8.19): execution is public, peer is private. */
export const SANDBOX = {
  execution: 'taco3064/nibfin-e2e-sandbox',
  peer: 'taco3064/nibfin-e2e-sandbox-peer',
} as const;

export type Visibility = 'public' | 'private';

export const KNOWN_VISIBILITY: Record<keyof typeof SANDBOX, Visibility> = { execution: 'public', peer: 'private' };

export const GH_NIBFIN_REPO = 'https://github.com/taco3064/gh-nibfin.git';

/** The Nibfin image `init` pins in the workflows it writes. */
export const IMAGE_DIGEST = /ghcr\.io\/taco3064\/nibfin@(sha256:[0-9a-f]{64})/g;

/** Pinned Podman for Windows hosts. */
export const PODMAN_MSI = {
  url: 'https://github.com/containers/podman/releases/download/v6.2.1/podman-installer-windows-amd64.msi',
  sha256: 'f53a29fccb6ff1ae999c293c20f340bdc13f7dfb1e6359fe7e67e7d2da5fa23c',
} as const;

/** Small public image that writes the login volume's settings.json (busybox 1.37.0, multi-arch index). */
export const HELPER_IMAGE = 'docker.io/library/busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec';

/** The CLI's login volume for Claude (Proposal R6.12, R6.21). */
export const CLAUDE_VOLUME = 'nibfin-home-claude';

/** Reads a required variable; the error names the variable, never a value. */
export function requireEnv(env: Env, name: 'E2E_SANDBOX_TOKEN' | 'E2E_CLAUDE_TOKEN'): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new Error(`missing environment variable ${name}`);
  return value.trim();
}
