// The delivery-lifecycle scenarios (Issue #285), in run order: phase 1 runs each alone,
// phase 2 is one concurrent group, phase 3 runs last.
import type { Scenario } from '../../src/types.ts';
import { interruptedDeliver, loginExpiry } from './phase1.ts';
import { assigneeRouting, fixLoops, peerDispatch, protectedPaths } from './phase2-fixtures.ts';
import { blockedByChain, deliveryLifecycle, deliveryParallel, pauseAndPending, shapeRewrite } from './phase2-journeys.ts';
import { noCredentials } from './phase3.ts';
import { requestAlreadyDone, requestFeasible, requestInfeasible } from './requests.ts';

export const lifecycleScenarios: Scenario[] = [
  loginExpiry,
  interruptedDeliver,
  deliveryLifecycle,
  deliveryParallel,
  blockedByChain,
  pauseAndPending,
  shapeRewrite,
  assigneeRouting,
  peerDispatch,
  protectedPaths,
  fixLoops,
  requestInfeasible,
  requestFeasible,
  requestAlreadyDone,
  noCredentials,
];
