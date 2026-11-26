import type { Visibility } from './host/config.ts';
import type { Env, ExecResult, Running } from './host/exec.ts';
import type { GitHub } from './host/github.ts';

/** Proposal rule id, `R<section>.<n>`, for example `R5.12`. */
export type RuleId = string;

export const PLATFORMS = ['linux', 'macos', 'windows'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const STATUSES = ['passed', 'failed', 'waiting'] as const;
/** `waiting` means the Proposal is ahead of the implementation (Proposal R8.20). */
export type Status = (typeof STATUSES)[number];

export interface Outcome {
  status: Status;
  reason: string;
}

/** A provisioning step's outcome, with facts later steps, scenarios and the result read. */
export type StepOutcome = Outcome & { facts?: Record<string, unknown> };

/** What a run is pinned to, as given on the command line. */
export interface RunTarget {
  ghNibfinCommit: string;
  platform: Platform;
}

/** The host and sandboxes as scenarios see them. */
export interface HostContext {
  /** The two fixed sandboxes (Proposal R8.19). */
  sandbox: { execution: string; peer: string };
  /** The clone of the execution sandbox where `runner add` ran. */
  executionDir: string;
  /** Runs `gh nibfin …` in the execution clone, logged in with the sandbox token. */
  ghNibfin(args: string[]): Promise<ExecResult>;
  /** GitHub REST and GraphQL with the sandbox token. */
  github: GitHub;
  /** Sets the execution sandbox's visibility, runs `fn`, then restores public; each change is read back. */
  withExecutionVisibility<T>(visibility: Visibility, fn: () => Promise<T>): Promise<T>;
  /** Starts `gh nibfin …` alongside the caller in the execution clone, with `GH_TOKEN`; `path` replaces the child's `PATH`. */
  startGhNibfin(args: string[], options?: { path?: string }): Running;
  /** Starts another long-lived child (for example `podman events`); it gets no secret. */
  start(argv: string[]): Running;
  /** Runs one child to its end without any secret (for example `podman ps`). */
  exec(argv: string[]): Promise<ExecResult>;
  /** `<repo root>/.e2e-work/`. */
  workDir(): string;
  /** The environment a browser gets: the host's, without any `E2E_*` variable and without `GH_TOKEN`. */
  browserEnv(): Env;
}

/** Context handed to provisioning steps and scenarios. */
export interface RunContext extends HostContext {
  target: RunTarget;
  /** Writes a log line to stderr; stdout holds only the JSON result. */
  log(message: string): void;
  /** Facts a provisioning step of this run returned, if it ran. */
  facts(stepId: string): Record<string, unknown> | undefined;
  /**
   * Registers a cleanup for the current scenario (or step). The runner runs them after it
   * ends, whatever its outcome, in reverse order and each with a bounded timeout.
   * `start` and `startGhNibfin` register their child's `stop()` themselves.
   */
  defer(cleanup: () => Promise<unknown>): void;
}

export interface ProvisioningStep {
  id: string;
  /** Ids of earlier steps that must pass first. */
  requires?: string[];
  run(ctx: RunContext): Promise<StepOutcome>;
  /** Runs after the scenarios when `run` ran, whatever its outcome, in reverse step order. */
  teardown?(ctx: RunContext): Promise<Outcome>;
}

export interface Scenario {
  id: string;
  /** Proposal rule ids this scenario verifies. */
  rules: RuleId[];
  platforms: Platform[];
  /** Ids of provisioning steps that must pass before this scenario runs. */
  requires?: string[];
  run(ctx: RunContext): Promise<Outcome>;
}

/** One coverage map entry: a covered rule, or a rule the Proposal marks 〔不測：…〕. */
export type MapEntry =
  | { id: RuleId; platforms: Platform[]; scenarios: string[] }
  | { id: RuleId; notE2e: string };

export type CoveredEntry = Extract<MapEntry, { scenarios: string[] }>;

export function isExcluded(entry: MapEntry): entry is Extract<MapEntry, { notE2e: string }> {
  return 'notE2e' in entry;
}
