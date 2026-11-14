import { environment } from './isolation-common.mjs';

// Worker contexts intentionally contain no protected host execution capability.
// Core's sandbox preflight and managed probe remain protected-runner operations.
// No worker-supplied observation or simulated denial can establish enforcement.
export function prerequisite(context) {
  const observed = JSON.stringify(environment(context, 'host/unobserved'));
  if (!context.sources?.core?.checkout) {
    return `Prepared Core source is required; ${observed}`;
  }
  if (process.platform !== 'linux') return true;
  return `Authorized protected sandbox probe unavailable; ${observed}`;
}
export function run(context) {
  return environment(context, 'host/unsupported');
}
export function verify() {
  return false;
}
export function describe(actual) {
  return JSON.stringify(actual);
}
