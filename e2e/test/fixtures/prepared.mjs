import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function run(context) {
  await writeFile(join(context.tempDir, 'scenario-only'), 'temporary');
  for (const source of Object.values(context.sources)) await access(source.checkout);
  return context.sources;
}
export async function verify(sources) {
  await access(sources.core.output.archive);
  await access(sources.action.output.entry);
  await access(sources.cli.output.entry);
  return Object.keys(sources).length === 3;
}
