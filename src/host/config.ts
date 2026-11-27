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

/** The CLI's login volume for Codex (Proposal R6.12, R6.21). */
export const CODEX_VOLUME = 'nibfin-home-codex';

/** The OS user that holds the collaborator's Runners, apart from the Owner's (Issue #300). */
export const PEER_USER = 'e2epeer';

/** Title prefix of the per-run SSH key on the second account; cleanup deletes only keys with it. */
export const PEER_KEY_TITLE_PREFIX = 'nibfin-e2e-peer-';

/** The title `runner add` gives its request Issue (Proposal R5.58). */
export const RUNNER_REQUEST_TITLE = 'Nibfin runner request';

/** The job-started hook's lines in a Job's **Set up runner** log (Proposal R6.7). */
export const HOOK_ACCEPTED = /Nibfin hook: accepted ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}), image (sha256:[0-9a-f]{64})/;
export const HOOK_REFUSED = /Nibfin hook: refused: ([^\r\n]*)/;

export type SecretName = 'E2E_SANDBOX_TOKEN' | 'E2E_CLAUDE_TOKEN' | 'NIBFIN_GITHUB_TOKEN' | 'E2E_PEER_GITHUB_TOKEN';

/** Reads a required variable; the error names the variable, never a value. */
export function requireEnv(env: Env, name: SecretName): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new Error(`missing environment variable ${name}`);
  return value.trim();
}

/** The gate's own repository, where `request` Issues are filed (Proposal R8.20). */
export const E2E_REPO = 'taco3064/nibfin-e2e';

/** Repositories whose open `scope` Issues mark rules waiting: the Proposal is ahead of their implementation. */
export const WATCHED_REPOS: readonly string[] = ['taco3064/nibfin-core', 'taco3064/gh-nibfin'];

/** Repositories whose delivered Issues select a rerun: the watched ones and the gate's own. */
export const DELIVERED_REPOS: readonly string[] = [...WATCHED_REPOS, E2E_REPO];

/** The first line of an approved Shape comment. */
export const SHAPE_MARKER = '<!-- nibfin:shape -->';

/** The label of the Issues the gate files (Proposal R3.2, R8.20). */
export const REQUEST_LABEL = 'request';

/** Hidden marker in every body and comment the gate writes, so a redo of the same run recognizes its own write. */
export function runMarker(runId: string): string {
  return `<!-- nibfin-e2e:run ${runId} -->`;
}

/**
 * Hidden marker for one leg's occurrences in a body or comment the gate writes, next to the run
 * marker, so a later filing in the same run (another leg or the final report) adds only the legs
 * not yet filed.
 */
export function legMarker(runId: string, platform: string): string {
  return `<!-- nibfin-e2e:run ${runId} leg ${platform} -->`;
}

/** Hidden markers around the gate-managed times of a "Proposal updated" request. */
export const PROPOSAL_STATE_MARKER = '<!-- nibfin-e2e:proposal-updated ';
export const PROPOSAL_STATE_END = '<!-- nibfin-e2e:proposal-updated-end -->';
