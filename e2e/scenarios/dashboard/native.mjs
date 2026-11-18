import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { sourceEnvironment } from '../../source-checkout.mjs';
import { sourceCommand, sourceTerminationUnknown } from '../../source-process.mjs';
import { coreFixture } from './core-fixture.mjs';
import { nativeCases, observationCases, diagnosisCases } from './cases.mjs';

export async function invokeDashboard(tempDir, signal, sources) {
  const root = join(tempDir, 'dashboard');
  try {
    return await sourceCommand('go', ['test', '-json', '-p=1', '-count=1', '-parallel=1',
      './internal/cli', '-run', '^TestE2EDashboard'], {
      cwd: join(root, 'source'), signal,
      env: { ...sourceEnvironment(root), E2E_CORE_ROOT: sources.core.checkout,
        E2E_NODE: process.execPath, E2E_BRIDGE: fileURLToPath(
          new URL('./bridge.mjs', import.meta.url)),
        E2E_DASHBOARD_FACTS: join(root, 'facts.json') },
    });
  } catch (error) {
    if (error.code === 'ENOENT') return { unavailable: 'Go toolchain unavailable' };
    throw error;
  }
}

export function nativeRequest(type) {
  return new Promise((resolve, reject) => {
    const receive = message => {
      if (message?.type !== `${type}-result`) return;
      parentPort.off('message', receive);
      if (message.error) reject(Object.assign(new Error(message.error), {
        terminationUnknown: message.terminationUnknown,
      }));
      else resolve(message.result);
    };
    parentPort.on('message', receive);
    parentPort.postMessage({ type: `${type}-native` });
  });
}

export async function prepareFixture(context) {
  const root = join(context.tempDir, 'dashboard');
  await mkdir(root);
  await cp(context.sources.cli.checkout, join(root, 'source'), {
    recursive: true, filter: path => path === context.sources.cli.checkout ||
      !['.git', 'gh-nibfin', 'gh-nibfin.exe', 'node_modules'].includes(basename(path)),
  });
  const { identity, subject, attempt } = await coreFixture(
    context.sources.core.checkout, 'one');
  const facts = { identity, subject, attempt, databaseId: 107,
    observations: observationCases, diagnoses: diagnosisCases };
  await writeFile(join(root, 'facts.json'), JSON.stringify(facts));
  for (const name of ['support', 'integration']) {
    await cp(new URL(`./${name}.go`, import.meta.url),
      join(root, 'source/internal/cli', `e2e_dashboard_${name}_test.go`));
  }
  return root;
}

export function verifyNative(commandResult) {
  const events = commandResult.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!events.some(event => ['skip', 'fail'].includes(event.Action)));
  const passed = events.filter(event => event.Action === 'pass' && event.Test)
    .map(event => event.Test);
  const required = [...nativeCases,
    ...observationCases.map(name => `TestE2EDashboardOverview/${name}`),
    ...diagnosisCases.map(name => `TestE2EDashboardDiagnosis/${name}`)];
  for (const name of required) assert.ok(passed.includes(name), `Missing: ${name}`);
  return passed;
}

export async function runIntegration(context) {
  let unknown = false;
  const root = join(context.tempDir, 'dashboard');
  try {
    await prepareFixture(context);
    const output = await (parentPort
      ? nativeRequest('dashboard') : invokeDashboard(context.tempDir,
        undefined, context.sources));
    if (output.unavailable) return output;
    return { evidence: 'controlled Core/CLI regression', passed: verifyNative(output) };
  } catch (error) {
    unknown = sourceTerminationUnknown(error);
    // Keep private native output out of ordinary reports.
    throw error;
  } finally {
    if (!unknown) await rm(root, { recursive: true, force: true });
  }
}
