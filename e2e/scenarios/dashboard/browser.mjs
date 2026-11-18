import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { prerequisite as integrationPrerequisite } from './contract.mjs';
import { prepareFixture, nativeRequest } from './native.mjs';
import { invokeDashboardBrowser } from './browser-native.mjs';
import { browserCases } from './cases.mjs';
import { sourceTerminationUnknown } from '../../source-process.mjs';

export async function prerequisite(context) {
  const native = await integrationPrerequisite(context);
  if (native !== true) return native;
  try {
    const root = context.sources.cli.checkout;
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (!manifest.devDependencies?.playwright) throw new Error('No browser package');
    await access(join(root, 'package-lock.json'));
    await access(join(root, 'tests/browser/host.mjs'));
    return true;
  } catch {
    return 'Prepared CLI lacks its maintained browser package, lockfile or host entry';
  }
}
export async function run(context) {
  const root = join(context.tempDir, 'dashboard');
  let unknown = false;
  try {
    await prepareFixture(context);
    const cli = join(root, 'source');
    const host = join(cli, 'internal/dashboard/e2efixture');
    await mkdir(host);
    await cp(join(cli, 'internal/dashboard/browsertest/diagnosis.go'),
      join(host, 'diagnosis.go'));
    for (const name of ['browser-host', 'browser-provider']) {
      await cp(new URL(`./${name}.go`, import.meta.url), join(host, `${name}.go`));
    }
    for (const name of ['browser-cases', 'browser-fixtures']) {
      await cp(new URL(`./${name}.mjs`, import.meta.url),
        join(cli, 'tests/browser', `e2e-${name}.mjs`));
    }
    await cp(new URL('./browser-run.mjs', import.meta.url),
      join(cli, 'tests/browser/e2e-dashboard.mjs'));
    await cp(new URL('./cases.mjs', import.meta.url),
      join(cli, 'tests/browser/e2e-cases.mjs'));
    const output = await (parentPort ? nativeRequest('dashboard-browser') :
      invokeDashboardBrowser(context.tempDir));
    return JSON.parse(output.stdout);
  } catch (error) {
    unknown = sourceTerminationUnknown(error);
    throw error;
  } finally {
    if (!unknown) await rm(root, { recursive: true, force: true });
  }
}
export function verify(actual) {
  if (actual.unavailable) return false;
  assert.deepEqual(actual.passed, browserCases);
  return true;
}
export const describe = actual => actual.unavailable ??
  'Packaged assets and controlled HTTP service; not live certification';
