import type { protectedSharedInstallation, InstallationResult,
  InvocationIdentity, InvocationReadback
} from './scenarios/cli-onboarding/installation.js';
export type { InvocationIdentity, InvocationReadback };
export interface InvocationPrerequisite {
  disposition: 'prerequisite';
  evidence: 'unverified';
  reason: 'protected-cli-invocation-required';
}
export type CliInvocationResult = InstallationResult | InvocationPrerequisite;
type InstallationOptions = Parameters<typeof protectedSharedInstallation>[0];
// Trusted composition owns adapters, credentials, source preparation and run identity.
// observe independently reads GitHub and host, returning InstallationObservation plus
// invocation: { github: InvocationReadback, host: InvocationReadback }.
// Each channel must bind fresh effects to this exact process, not echo its request.
export function protectedCliInvocation(options?: Omit<InstallationOptions,
  'invocationRun'> & { run: { runId: string; attempt: number } }): {
  run(): Promise<CliInvocationResult>;
};
