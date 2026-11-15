import { runFaultLifecycle } from './fault-lifecycle.mjs';
import { runPause } from './pause-protected.mjs';
import { runDependency } from './dependency-protected.mjs';

// Protected caller composition only. Ordinary scenarios still refuse capabilities.
export function runLifecycle(request, caller, bounds = {}) {
  if (request?.case === 'pause-resume') {
    return runPause(request.repository, caller, bounds);
  }
  if (request?.case === 'dependency-fanout') {
    return runDependency(request, caller, bounds);
  }
  return runFaultLifecycle(request, caller, bounds);
}
