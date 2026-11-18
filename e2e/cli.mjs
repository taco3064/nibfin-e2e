import { groupArguments } from './source-selection.mjs';
import { operatorInvestigation } from './operator-composition.mjs';
import { suiteCommand, suiteExitCode } from './suite-cli.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { scenarios } from './registry.mjs';
import { run, runPrepared } from './runner.mjs';
import { exitCode, report } from './schema.mjs';

export const suiteRequest = args => args.some(arg =>
  ['--suite', '--run-id', '--state-dir', '--phase', '--resume'].includes(arg));

export async function command(args, entries = scenarios, investigation) {
  if (suiteRequest(args)) return suiteCommand(args, investigation);
  try {
    const { groups, selection } = groupArguments(args);
    const execute = entries === scenarios ? runPrepared : run;
    return await execute(entries, groups, {
      diagnostic: chunk => process.stderr.write(chunk),
      sourceOptions: { selection },
    });
  } catch (error) {
    return report([], [`INVOCATION_OR_RUNNER_ERROR: ${error.message}`]);
  }
}
const entry = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (entry === import.meta.url) {
  const args = process.argv.slice(2);
  const investigation = suiteRequest(args) ? operatorInvestigation() : undefined;
  const document = await command(args, scenarios, investigation);
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.exitCode = document.kind === 'suite' ? suiteExitCode(document) :
    exitCode(document);
}
