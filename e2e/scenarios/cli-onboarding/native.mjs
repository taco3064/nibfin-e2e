import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { invokeNative, nativeFailure } from './native-command.mjs';

export const nativeCases = Object.freeze([
  'TestE2EInitPreview', 'TestE2EInitApply', 'TestE2EInitDenials',
  'TestE2EInitSourceBoundary',
  'TestE2EInitUnknown', 'TestE2EUpgradePreview', 'TestE2EUpgradeApply',
  'TestE2EUpgradeDenials', 'TestE2EUpgradeUnknown',
]);
const drivers = ['support', 'init', 'upgrade'];

// Copy test sources, never modify the prepared producer or its declarations.
// The producer's own synthetic transport helpers are reused, not its assertions.
function workerCommand() {
  return new Promise((resolve, reject) => {
    const receive = message => {
      if (message?.type !== 'cli-onboarding-result') return;
      parentPort.off('message', receive);
      if (message.error) reject(new Error(message.error));
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
  try {
    await cp(context.sources.cli.checkout, checkout, {
      recursive: true,
      filter: path => !['.git', 'gh-nibfin', 'gh-nibfin.exe'].includes(basename(path)),
    });
    for (const name of drivers) {
      const path = new URL(`./${name}.go`, import.meta.url);
      await cp(path, join(checkout, 'internal/cli', `e2e_${name}_test.go`));
    }
    await mkdir(join(root, 'home'));
    const result = command ? await command() : parentPort ? await workerCommand() :
      await invokeNative(context.tempDir);
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
    if (events.some(event => ['fail', 'skip'].includes(event.Action))) {
      throw new Error('NATIVE_ASSERTIONS_INCOMPLETE');
    }
    return { evidence: 'synthetic', passed, sources: context.sources };
  } catch (error) {
    if (error.stdout) {
      throw new Error(nativeFailure(error));
    }
    throw error;
  } finally {
    // sourceCommand settles only after killing descendants and closing pipes.
    await rm(root, { recursive: true, force: true });
  }
}
