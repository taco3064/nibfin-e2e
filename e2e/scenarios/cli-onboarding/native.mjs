import { cp, mkdir, rm } from 'node:fs/promises';
import { sourceTerminationUnknown } from '../../source-process.mjs';
import { withManagedFixture } from './managed-fixture.mjs';
import { basename, join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { invokeNative, managedCases, managedResumeCase, nativeFailure }
  from './native-command.mjs';

export const nativeCases = Object.freeze([
  'TestE2EInitPreview', 'TestE2EInitApply', 'TestE2EInitDenials',
  'TestE2EInitSourceBoundary',
  'TestE2EInitUnknown', 'TestE2EUpgradePreview', 'TestE2EUpgradeApply',
  'TestE2EUpgradeDenials', 'TestE2EUpgradeUnknown', 'TestE2EUpgradeAdoption',
]);
const drivers = ['support', 'init', 'upgrade', 'managed-fixture_linux',
  'managed-host_linux', 'managed-resume_linux', 'managed-readback_linux',
  'desktop-fixture_linux', 'desktop_linux', 'desktop-assets_linux',
  'desktop-guards_linux', 'replacement_linux', 'replacement-effects_linux',
  'replacement-observer_linux', 'replacement-authority_linux',
  'replacement-host_linux', 'replacement-orchestration_linux'];
export const requiredManagedCases = Object.freeze(process.platform === 'linux'
  ? [managedResumeCase, ...managedCases,
    'TestE2EReplacementRecovery', 'TestE2EReplacementUnknownProvider',
    'TestE2EReplacementPreview', 'TestE2EReplacementReadbackAndReplay',
    'TestE2EReplacementRemovalAuthority',
    'TestE2EReplacementHostReadback'] : []);

export const requiredDesktopCases = Object.freeze(process.platform === 'linux' ? [
  'TestE2EDesktopInventory', 'TestE2EDesktopConsentAndHandoff',
  'TestE2EDesktopDrift', 'TestE2EDesktopEnvironment', 'TestE2EDesktopAssets',
  'TestE2EDesktopPlatformRejections', 'TestE2EDesktopLinuxGuards',
] : []);

// Copy test sources, never modify the prepared producer or its declarations.
// The producer's own synthetic transport helpers are reused, not its assertions.
function workerCommand() {
  return new Promise((resolve, reject) => {
    const receive = message => {
      if (message?.type !== 'cli-onboarding-result') return;
      parentPort.off('message', receive);
      if (message.error) {
        const error = new Error(message.error);
        error.terminationUnknown = message.terminationUnknown === true;
        reject(error);
      }
      else resolve(message.result);
    };
    parentPort.on('message', receive);
    parentPort.postMessage({ type: 'cli-onboarding-native' });
  });
}

export async function executeNative(context, command) {
  const root = join(context.tempDir, 'cli-contract');
  const checkout = join(root, 'source');
  await mkdir(root);
  let terminationUnknown = false;
  try {
    await cp(context.sources.cli.checkout, checkout, {
      recursive: true,
      filter: path => path === context.sources.cli.checkout ||
        !['.git', 'gh-nibfin', 'gh-nibfin.exe'].includes(basename(path)),
    });
    for (const name of drivers) {
      const path = new URL(`./${name}.go`, import.meta.url);
      await cp(path, join(checkout, 'internal/cli', `e2e_${name}_test.go`));
    }
    await mkdir(join(root, 'home'));
    return await withManagedFixture(root, async () => {
      const result = await (command ? command() : parentPort ? workerCommand() :
        invokeNative(context.tempDir, undefined, context.sources.core));
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      const passed = events.filter(event => event.Action === 'pass' && event.Test)
        .map(event => event.Test);
      for (const name of nativeCases) {
        for (const suffix of ['', '/User', '/Organization']) {
          if (!passed.includes(name + suffix)) {
            throw new Error(`NATIVE_ASSERTIONS_MISSING: ${name + suffix}`);
          }
        }
      }
      for (const name of [...requiredManagedCases, ...requiredDesktopCases]) {
        if (!passed.includes(name)) throw new Error(`NATIVE_ASSERTIONS_MISSING: ${name}`);
      }
      if (events.some(event => ['fail', 'skip'].includes(event.Action))) {
        throw new Error('NATIVE_ASSERTIONS_INCOMPLETE');
      }
      return { evidence: 'synthetic', passed, sources: context.sources,
        replacement: result.replacement };
    });
  } catch (error) {
    terminationUnknown = sourceTerminationUnknown(error);
    if (!terminationUnknown && error.stdout) {
      throw new Error(nativeFailure(error));
    }
    throw error;
  } finally {
    // sourceCommand settles only after killing descendants and closing pipes.
    if (!terminationUnknown) await rm(root, { recursive: true, force: true });
  }
}
