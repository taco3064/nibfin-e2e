import { fileURLToPath } from 'node:url';
import { createScenarios } from '../scenarios/index.ts';
import { createHostContext } from './host/context.ts';
import { createServices } from './host/services.ts';
import { createProvisioning } from './provisioning.ts';
import type { ProvisioningStep, Scenario } from './types.ts';

// Creating the services touches nothing: the environment is read and `.e2e-work/` is
// reset only when a step first needs them.
const services = createServices(fileURLToPath(new URL('..', import.meta.url)), (m) => process.stderr.write(m + '\n'));

// Explicit lists. Scenario modules live under `scenarios/`; `scenarios/index.ts` imports and lists each one.
export const scenarios: Scenario[] = createScenarios(services);

/** Provisioning steps, in the order they run. */
export const provisioning: ProvisioningStep[] = createProvisioning(services);

/** The host and sandboxes scenarios reach through their context. */
export const host = createHostContext(services);
