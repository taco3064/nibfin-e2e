import { invokeNative } from './scenarios/cli-onboarding/native-command.mjs';
import { invokeManagedWake } from './scenarios/managed-wake/native.mjs';
import { invokeDashboard } from './scenarios/dashboard/native.mjs';
import { invokeDashboardBrowser } from './scenarios/dashboard/browser-native.mjs';

// Only these fixed operations can be requested by a worker. The originating
// module is checked by the parent before any native process can start.
const operations = new Map([
  ['cli-onboarding', 'cli-onboarding/contract.mjs',
    (root, signal, sources) => invokeNative(root, signal, sources?.core)],
  ['managed-wake', 'managed-wake/contract.mjs', invokeManagedWake],
  ['dashboard', 'dashboard/contract.mjs', invokeDashboard],
  ['dashboard-browser', 'dashboard/browser.mjs', invokeDashboardBrowser],
].map(([name, path, invoke]) => [`${name}-native`, Object.freeze({
  module: new URL(`./scenarios/${path}`, import.meta.url).href,
  response: `${name}-result`, invoke,
})]));

export const nativeDispatch = message => operations.get(message?.type);
