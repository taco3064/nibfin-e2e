import type { Visibility } from './host/config.ts';
import type { Env, ExecResult, Running } from './host/exec.ts';
import type { GitHub } from './host/github.ts';
import type { HostOperations } from './host/operations.ts';
import type { PeerHandle } from './host/peer.ts';

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

/** What a scenario may pass to a child: stdin and extra variables (never `GH_TOKEN` or `E2E_*`). */
export interface ChildOptions {
  input?: string;
  env?: Record<string, string>;
}

/** The host and sandboxes as scenarios see them; the host operations are Linux only. */
export interface HostContext extends HostOperations {
  /** The two fixed sandboxes (Proposal R8.19). */
  sandbox: { execution: string; peer: string };
  /**
   * Aborted once when the harness budget's work limit passes; waits reject with its
   * reason so the stuck work unwinds. Teardown gets a signal that never aborts.
   */
  signal: AbortSignal;
  /** The clone of the execution sandbox where `runner add` ran. */
  executionDir: string;
  /** Runs `gh nibfin …` in the execution clone, logged in with the sandbox token. */
  ghNibfin(args: string[], options?: ChildOptions): Promise<ExecResult>;
  /** Runs `gh …` logged in with the sandbox token. */
  gh(args: string[], options?: ChildOptions & { cwd?: string }): Promise<ExecResult>;
  /** A path under the run's `.e2e-work/` directory. */
  workPath(...parts: string[]): string;
  /** The `nibfin-home-claude` volume's settings.json, compared in memory only (it holds the token). */
  claudeSettings(): Promise<Record<string, unknown> | undefined>;
  /** GitHub REST and GraphQL with the sandbox token. */
  github: GitHub;
  /** Sets the execution sandbox's visibility, runs `fn`, then restores public; each change is read back. */
  withExecutionVisibility<T>(visibility: Visibility, fn: () => Promise<T>): Promise<T>;
  /** Starts `gh nibfin …` alongside the caller in the execution clone, with `GH_TOKEN`; `path` replaces the child's `PATH`. */
  startGhNibfin(args: string[], options?: { path?: string }): Running;
  /** Starts another long-lived child (for example `podman events`); it gets no secret. */
  start(argv: string[]): Running;
  /** Runs one child to its end without any secret (for example `podman ps`), with optional stdin, cwd and extra variables. */
  exec(argv: string[], options?: ChildOptions & { cwd?: string }): Promise<ExecResult>;
  /** `<repo root>/.e2e-work/`. */
  workDir(): string;
  /** The environment a browser gets: the host's, without any `E2E_*` variable and without `GH_TOKEN`. */
  browserEnv(): Env;
  /** The collaborator (a second account, a write Collaborator on the execution sandbox) and its OS user; throws unless the `collaborator` step passed. */
  peer(): PeerHandle;
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
  /**
   * Ids of the scenarios this run still starts after the current one (and its concurrent
   * group), in run order; for a provisioning step, every scenario to run, and for a teardown, none.
   */
  upcoming(): string[];
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
  /**
   * Consecutive `concurrent` scenarios (in registry order) start together and are
   * awaited together; every other scenario runs alone. Defaults to off.
   */
  concurrent?: boolean;
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
