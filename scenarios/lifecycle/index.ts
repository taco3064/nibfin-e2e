// The delivery-lifecycle scenarios (Issue #285), in run order: phase 1 runs each alone,
// then `review-events` alone (its approval ruleset covers the whole execution sandbox),
// phase 2 is one concurrent group, then `resolution-spec-fix` alone (it reads every branch
// write in its window), phase 3 runs last. They all run before the
// collaborator scenarios (src/registry.ts), so `review-events` sees the execution
// sandbox still public and no peer Runner registered.
import type { Scenario } from '../../src/types.ts';
import { interruptedDeliver, loginExpiry } from './phase1.ts';
import { assigneeRouting, fixLoops, peerDispatch, protectedPaths } from './phase2-fixtures.ts';
import {
  blockedByChain,
  deliveryLifecycle,
  deliveryParallel,
  pauseAndPending,
  shapeRewrite,
} from './phase2-journeys.ts';
import { noCredentials } from './phase3.ts';
import { reviewEvents } from './review-events.ts';
import { reviewRebase } from './review-rebase.ts';
import { resolutionSpecFix } from './resolution-spec-fix.ts';
import { requestAlreadyDone, requestFeasible, requestInfeasible } from './requests.ts';
import { resolutionDecision } from './resolution-decision.ts';

export const lifecycleScenarios: Scenario[] = [
  loginExpiry,
  interruptedDeliver,
  reviewEvents,
  deliveryLifecycle,
  deliveryParallel,
  blockedByChain,
  pauseAndPending,
  shapeRewrite,
  assigneeRouting,
  peerDispatch,
  protectedPaths,
  fixLoops,
  reviewRebase,
  requestInfeasible,
  requestFeasible,
  requestAlreadyDone,
  resolutionDecision,
  resolutionSpecFix,
  noCredentials,
];
