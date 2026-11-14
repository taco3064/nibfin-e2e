import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source ownership stays with prepareSources. This consumer package imports the
// producer's public App seams; it neither edits nor replaces producer behavior.
export async function buildRunnerContract(checkout, invoke) {
  const directory = join(checkout, 'nibfin-e2e-runner-contract');
  await mkdir(directory);
  for (const name of ['main.go', 'provider.go', 'package.go']) {
    await copyFile(fileURLToPath(new URL(`runner-contract/${name}`, import.meta.url)),
      join(directory, name));
  }
  const entry = join(directory, 'contract');
  await invoke('go', ['build', '-trimpath', '-o', entry,
    './nibfin-e2e-runner-contract']);
  // Execute under the source owner's bounded process group, outside workers.
  const observed = await invoke(entry, [], { timeoutMs: 60000 });
  const report = join(directory, 'observations.json');
  await writeFile(report, observed.stdout, { mode: 0o600 });
  return report;
}
