import type { SourceIdentity } from './handoff.js';
export interface InstallationBinding {
  owner: string;
  hostId: string;
  repository: string;
  repositoryId: number;
  memberId: number;
}
export type InstallationSources = Record<'core' | 'action' | 'cli', SourceIdentity>;
export interface SharedRegistration {
  id: number | null;
  name: string | null;
  memberId: number | null;
  repositoryId: number | null;
  endpoint: string | null;
  localId: number | null;
  localName: string | null;
  shared: boolean | null;
  status: 'online' | 'offline' | null;
}
export interface InstallationObservation {
  binding: { [K in keyof InstallationBinding]: InstallationBinding[K] | null };
  sources: Record<'core' | 'action' | 'cli', {
    repository: string | null; commit: string | null;
  }>;
  installation: {
    pullRequest: { number: number | null; headCommit: string | null;
      repositoryId: number | null } | null;
    checks: 'passed' | 'pending' | 'failed' | 'not-required' | null;
    reviewed: boolean | null;
    merged: boolean | null;
    contentMatches: boolean | null;
  };
  host: { ready: boolean | null; serviceUser: string | null;
    serviceState: 'active' | 'inactive' | 'failed' | null };
  endpoint: string | null;
  registrationsComplete: boolean | null;
  runnerCount: number | null;
  runners: SharedRegistration[] | null;
}
export interface InstallationIntent { operation: 'init'; sequence: number }
export interface InstallationResult {
  origin: 'synthetic' | 'operator';
  binding: InstallationBinding;
  sources: InstallationSources;
  phase: 'binding' | 'inspection' | 'source-compatibility' | 'reconciliation' |
    'binding-conflict' | 'source-conflict' | 'endpoint-conflict' |
    'registration-conflict' | 'checks-failed' | 'unknown' | 'installation-pr' |
    'host-prerequisites' | 'registration' | 'startup' | 'online-readback' | 'installed';
  disposition: 'success' | 'incomplete' | 'denied' | 'contradiction';
  refused: { operation: string; memberId: number; expectedRole: string } | null;
  observation: InstallationObservation | null;
  protectedExecution: 'unverified';
  inventory: {
    path: string;
    owner: string;
    hostId: string;
    repositories: { repository: string | null; id: number | null }[];
    runners: SharedRegistration[];
    pending: InstallationIntent | null;
  };
}
export interface InstallationCall {
  signal: AbortSignal;
  intent?: InstallationIntent | null;
}
// Only the separately authorized operator implements these capabilities.
// command owns deadlines, cancellation, group termination and private credentials.
export interface InstallationContext {
  origin: InstallationResult['origin'];
  binding: InstallationBinding;
  credentials: { capabilities(): Promise<{ user: {
    status: string; role: string; actorId: number; ownerId: number; repository: string;
  } }> };
  authorize(request: InstallationBinding & {
    operation: string; signal: AbortSignal;
  }): Promise<boolean>;
  observe(binding: InstallationBinding, call: InstallationCall): Promise<unknown>;
  reconcile(binding: InstallationBinding, intent: InstallationIntent,
    call: InstallationCall): Promise<{
    terminated: boolean; effects: 'reconciled' | 'unknown';
  }>;
  command(entry: string, args: string[], options: InstallationCall & {
    stdin: 'ignore'; timeoutMs: number; limit: number;
    binding: InstallationBinding;
  }): Promise<{ exitCode: number; stdout: string; terminated: boolean }>;
}
export function protectedSharedInstallation(options: {
  sources: Record<'core' | 'action' | 'cli', SourceIdentity & {
    checkout: string;
    output: { entry?: string; pin?: SourceIdentity & {
      archiveHash: string; manifestHash: string;
    } };
  }>;
  inventory: { path: string; exclusive<T>(action: (
    state: Record<string, unknown>, save: () => Promise<void>,
  ) => Promise<T>): Promise<T> };
  context: InstallationContext;
  bounds?: { requests?: number; operations?: number;
    timeoutMs?: number; requestTimeoutMs?: number };
}): { install(): Promise<InstallationResult> };
