import { fileURLToPath } from 'node:url';
import { createScenarios } from '../scenarios/index.ts';
import { createKit } from '../scenarios/lib/kit.ts';
import { lifecycleScenarios } from '../scenarios/lifecycle/index.ts';
import { createHostContext } from './host/context.ts';
import { createServices } from './host/services.ts';
import { createProvisioning } from './provisioning.ts';
import type { ProvisioningStep, Scenario } from './types.ts';
import { dashboardLoginRelay } from '../scenarios/dashboard/login-relay.ts';
import { dashboardOperations } from '../scenarios/dashboard/operations.ts';
import { dashboardServing } from '../scenarios/dashboard/serving.ts';
import { dashboardUpdates } from '../scenarios/dashboard/updates.ts';
import { dashboardViews } from '../scenarios/dashboard/views.ts';
import { dashboard } from '../scenarios/management/dashboard.ts';
import { failurePending } from '../scenarios/management/failure-pending.ts';
import { hostRequirements } from '../scenarios/management/host-requirements.ts';
import { runnerLocation } from '../scenarios/management/runner-location.ts';
import { extensionReleases, imageDigest } from '../scenarios/management/image-release.ts';
import { initFiles } from '../scenarios/management/init-files.ts';
import { initSettings } from '../scenarios/management/init-settings.ts';
import { confirmPreview, pauseResume } from '../scenarios/management/labels.ts';
import { loginCommand } from '../scenarios/management/login-command.ts';
import { podmanMachineDetached } from '../scenarios/management/podman-machine-detached.ts';
import { runnerAddSetup } from '../scenarios/management/runner-add-setup.ts';
import { runnerAddLogin } from '../scenarios/management/runner-add-login.ts';
import { runnerNoPeriodic } from '../scenarios/management/runner-no-periodic.ts';
import { runnerRemove } from '../scenarios/management/runner-remove.ts';
import { statusViews } from '../scenarios/management/status-views.ts';
import { upgrade } from '../scenarios/management/upgrade.ts';
import { imageSwitch } from '../scenarios/management/image-switch.ts';
import { wording } from '../scenarios/management/wording.ts';
import { siteDeployOnPush } from '../scenarios/site/deploy-on-push.ts';
import { livePage } from '../scenarios/site/live-page.ts';

// Creating the services touches nothing: the environment is read and `.e2e-work/` is
// reset only when a step first needs them.
const services = createServices(fileURLToPath(new URL('..', import.meta.url)), (m) => process.stderr.write(m + '\n'));

// Explicit lists, in run order (consecutive `concurrent` scenarios start together, see
// `Scenario.concurrent`). Scenario modules live under `scenarios/`; `scenarios/index.ts`
// imports and lists the Issue #299 ones, and the others are listed here. The installation and
// management scenarios run first: they read the fresh host and the init PRs, and upgrade, which
// changes main's workflow, runs before the long lifecycle scenarios so GHCR's main image has
// little time to move after init. image-switch, which pins an earlier image on main and checks that a running
// Job keeps it while the next Job runs the upgraded one, runs alone right after upgrade for the same reason and
// restores main's pin before the lifecycle scenarios. They leave their fixture Issues paused or without `scope`, and the
// delivery-lifecycle scenarios judge only their own tagged fixtures and runs created since they
// started. Then Issue #299's, the site and the Dashboard scenarios, which need earlier work in
// the sandboxes to have settled. runner-add-login (alone, with no fixture waiting for a Runner)
// starts a Codex login and abandons it at the guide. runner-remove, which removes every local Runner and the login
// volume, runs last.
export const scenarios: Scenario[] = [
  runnerAddSetup,
  // Right after runner-add-setup: only this host's Runners are registered and nothing has changed them yet.
  hostRequirements((ctx) => createKit(services, ctx)),
  // Also there, before podman-machine-detached restarts the machine: where those Runners run,
  // on the Linux host or inside the podman machine VM (R5.10).
  runnerLocation((ctx) => createKit(services, ctx)),
  // Reads only: compares the host (and the podman machine VM) with the state before runner add.
  runnerNoPeriodic,
  // Alone, before the delivery scenarios and with no fixture Job running: stops and restarts the Windows podman machine.
  podmanMachineDetached,
  initSettings,
  initFiles,
  imageDigest,
  extensionReleases,
  wording,
  dashboard,
  statusViews,
  pauseResume,
  confirmPreview,
  failurePending,
  upgrade,
  imageSwitch((ctx) => createKit(services, ctx)),
  ...lifecycleScenarios,
  ...createScenarios(services),
  livePage,
  siteDeployOnPush,
  dashboardServing,
  dashboardViews,
  dashboardOperations,
  dashboardUpdates,
  dashboardLoginRelay,
  runnerAddLogin,
  // Alone, with no Job on the Claude login volume: starts a Claude re-login, abandons it at the guide.
  loginCommand,
  runnerRemove,
];

/** Provisioning steps, in the order they run. */
export const provisioning: ProvisioningStep[] = createProvisioning(services);

/** The host and sandboxes scenarios reach through their context. */
export const host = createHostContext(services);
