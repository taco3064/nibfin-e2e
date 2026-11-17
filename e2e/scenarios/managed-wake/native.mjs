import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { producerFile } from '../../source-producers.mjs';
import { sourceEnvironment } from '../../source-checkout.mjs';
import { sourceCommand, sourceTerminationUnknown } from '../../source-process.mjs';

export function invokeManagedWake(tempDir, signal) {
  const root = join(tempDir, 'managed-activation');
  return sourceCommand('go', ['test', '-json', '-p=1', '-count=1', '-parallel=1',
    '-timeout=90s', './internal/cli', '-run', '^TestE2EManagedWakeActivation$'], {
    cwd: join(root, 'source'), timeoutMs: 600000, signal,
    env: { ...sourceEnvironment(root), GOCACHE: join(tempDir, 'managed-go-cache'),
      E2E_RECIPES: join(root, 'recipes.json'),
      E2E_SHARED_WORKFLOW: join(root, 'shared-runner.yml') },
  });
}
function workerCommand() {
  return new Promise((resolve, reject) => {
    const receive = message => {
      if (message?.type !== 'managed-wake-result') return;
      parentPort.off('message', receive);
      if (message.error) {
        const error = new Error(message.error);
        error.terminationUnknown = message.terminationUnknown;
        reject(error);
      } else resolve(message.result);
    };
    parentPort.on('message', receive);
    parentPort.postMessage({ type: 'managed-wake-native' });
  });
}
export async function activate(context) {
  const root = join(context.tempDir, 'managed-activation');
  await mkdir(root);
  let unknown = false;
  try {
    await cp(context.sources.cli.checkout, join(root, 'source'), {
      recursive: true, filter: path => path === context.sources.cli.checkout ||
        !['.git', 'gh-nibfin'].includes(basename(path)),
    });
    await cp(new URL('./activation.go', import.meta.url),
      join(root, 'source/internal/cli/e2e_managed_wake_test.go'));
    await cp(await producerFile(context.sources.core.checkout, 'src/caller-recipes.json'),
      join(root, 'recipes.json'));
    await cp(await producerFile(context.sources.core.checkout,
      '.github/workflows/shared-runner.yml'), join(root, 'shared-runner.yml'));
    const result = await (parentPort ? workerCommand() :
      invokeManagedWake(context.tempDir));
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.Action === 'pass' &&
      event.Test === 'TestE2EManagedWakeActivation'));
    assert.ok(!events.some(event => ['skip', 'fail'].includes(event.Action)));
    const records = events.map(event => event.Output ?? '').join('')
      .split('\n').filter(line => line.includes('MANAGED_WAKE='));
    assert.equal(records.length, 1);
    const activation = JSON.parse(records[0].split('MANAGED_WAKE=')[1]);
    assert.equal(activation.pin.commit, context.sources.core.commit);
    assert.deepEqual(activation.pin, context.sources.core.output.pin);
    // Bind the copied producer's declaration without rewriting it.
    const pins = JSON.parse(await readFile(await producerFile(
      context.sources.cli.checkout, 'internal/cli/producers.json'), 'utf8'));
    assert.deepEqual(pins.core, activation.pin);
    return activation;
  } catch (error) {
    unknown = sourceTerminationUnknown(error);
    if (error.stdout) error.message += '\n' + error.stdout;
    throw error;
  } finally {
    if (!unknown) await rm(root, { recursive: true, force: true });
  }
}
