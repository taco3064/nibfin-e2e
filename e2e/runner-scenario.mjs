import { readFile } from 'node:fs/promises';
import { verifyRunnerContract } from './runner-observations.mjs';

export function prerequisite({ sources }) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    return 'Controlled host combination unsupported; Windows/WSL unverified';
  }
  return sources?.cli?.output?.runnerContract ? true :
    'Prepared current-main CLI contract observations unavailable';
}

export async function run({ sources }) {
  const observed = await readFile(sources.cli.output.runnerContract, 'utf8');
  return { ...JSON.parse(observed), source: {
    repository: sources.cli.repository, commit: sources.cli.commit,
  } };
}

export const verify = verifyRunnerContract;
