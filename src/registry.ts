import type { ProvisioningStep, Scenario } from './types.ts';

// Explicit import lists. Scenario modules live under `scenarios/`; import each one
// here and list it. Real scenarios and host provisioning arrive with later Issues.
export const scenarios: Scenario[] = [];

/** Provisioning steps, in the order they run. */
export const provisioning: ProvisioningStep[] = [];
