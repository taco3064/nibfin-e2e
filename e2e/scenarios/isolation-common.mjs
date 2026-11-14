import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export async function coreModule(context, path) {
  return import(pathToFileURL(join(context.sources.core.checkout, path)).href);
}
export function environment(context, mode) {
  return {
    mode, os: process.platform, node: process.version,
    sources: Object.values(context.sources ?? {}).map(source => ({
      repository: source.repository, commit: source.commit,
    })),
  };
}
export function prerequisite(context) {
  if (!context.sources?.core?.checkout) return 'Prepared Core source is required';
  return true;
}
