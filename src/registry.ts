import { fileURLToPath } from 'node:url';
import { createScenarios } from '../scenarios/index.ts';
import { createHostContext } from './host/context.ts';
import { createServices } from './host/services.ts';
import { createProvisioning } from './provisioning.ts';
import type { ProvisioningStep, Scenario } from './types.ts';
import { dashboardLoginRelay } from '../scenarios/dashboard/login-relay.ts';
import { dashboardOperations } from '../scenarios/dashboard/operations.ts';
import { dashboardServing } from '../scenarios/dashboard/serving.ts';
import { dashboardUpdates } from '../scenarios/dashboard/updates.ts';
import { dashboardViews } from '../scenarios/dashboard/views.ts';
import { siteDeployOnPush } from '../scenarios/site/deploy-on-push.ts';
import { livePage } from '../scenarios/site/live-page.ts';

// Creating the services touches nothing: the environment is read and `.e2e-work/` is
// reset only when a step first needs them.
const services = createServices(fileURLToPath(new URL('..', import.meta.url)), (m) => process.stderr.write(m + '\n'));

// Explicit lists. Scenario modules live under `scenarios/`; `scenarios/index.ts` imports and lists each one,
// and the Dashboard and site scenarios are listed here after them. The Dashboard scenarios run
// last: they need earlier work in the sandboxes to have settled.
export const scenarios: Scenario[] = [
  ...createScenarios(services),
  livePage,
  siteDeployOnPush,
  dashboardServing,
  dashboardViews,
  dashboardOperations,
  dashboardUpdates,
  dashboardLoginRelay,
];

/** Provisioning steps, in the order they run. */
export const provisioning: ProvisioningStep[] = createProvisioning(services);

/** The host and sandboxes scenarios reach through their context. */
export const host = createHostContext(services);
