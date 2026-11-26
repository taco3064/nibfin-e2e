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

/** What a run is pinned to. Values are recorded as given on the command line. */
export interface RunTarget {
  ghNibfinCommit: string;
  image: string;
  imageDigest: string;
  platform: Platform;
}

/** Context handed to provisioning steps and scenarios. It carries no GitHub client or credentials. */
export interface RunContext {
  target: RunTarget;
  /** Writes a log line to stderr; stdout holds only the JSON result. */
  log(message: string): void;
}

export interface ProvisioningStep {
  id: string;
  run(ctx: RunContext): Promise<Outcome>;
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
