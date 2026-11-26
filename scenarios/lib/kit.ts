import { createStream } from '../../src/host/exec.ts';
import type { Env, Exec, Stream } from '../../src/host/exec.ts';
import type { GitHub } from '../../src/host/github.ts';
import type { HostServices } from '../../src/host/services.ts';
import type { RunContext } from '../../src/types.ts';

/** main's head right after `init`'s PR merged, recorded by the `nibfin` step. */
export interface Baseline {
  commit: string;
  tree: string;
}

/** What the scenario library reaches the host and GitHub through. Tests replace each part. */
export interface Kit {
  github: GitHub;
  exec: Exec;
  stream: Stream;
  /** Unauthenticated fetch for the registry. */
  fetch: typeof fetch;
  sandbox: { execution: string; peer: string };
  /** `<repo root>/.e2e-work/`, ignored by Git. */
  workDir: string;
  env: Env;
  log(message: string): void;
  facts(stepId: string): Record<string, unknown> | undefined;
  /** Values that must never appear in a log or comment; compared in memory only. */
  secrets(): string[];
  /** The sandbox token, only for `gh` as GH_TOKEN. */
  ghToken(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function createKit(host: HostServices, ctx: RunContext): Kit {
  return {
    github: ctx.github,
    exec: host.exec,
    stream: createStream(host.env, ctx.log),
    fetch: host.fetch,
    sandbox: ctx.sandbox,
    workDir: host.workDir(),
    env: host.env,
    log: ctx.log,
    facts: ctx.facts,
    ghToken: () => host.sandboxToken(),
    secrets: () => [host.env.E2E_SANDBOX_TOKEN, host.env.E2E_CLAUDE_TOKEN].map((s) => s?.trim()).filter((s): s is string => !!s),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** Builds the kit for a run; scenarios take one so tests can replace the host. */
export type KitFor = (ctx: RunContext) => Kit;

/** The baseline the `nibfin` step recorded for the sandbox. */
export function baselineOf(kit: Kit, repo: string): Baseline {
  const facts = kit.facts('nibfin');
  const b = (repo === kit.sandbox.execution ? facts?.executionBaseline : repo === kit.sandbox.peer ? facts?.peerBaseline : undefined) as Baseline | undefined;
  if (!b || typeof b.commit !== 'string' || typeof b.tree !== 'string') throw new Error(`${repo}: the nibfin step recorded no baseline for main`);
  return b;
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
