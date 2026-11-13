import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { scenarios } from './registry.mjs';
import { run } from './runner.mjs';
import { exitCode, report } from './schema.mjs';

export async function command(args, entries = scenarios) {
  try {
    const groups = [];
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== '--group' || !args[index + 1] ||
          args[index + 1].startsWith('--')) {
        throw new Error('Usage: npm run e2e -- [--group NAME ...]');
      }
      groups.push(args[++index]);
    }
    return await run(entries, groups, {
      diagnostic: chunk => process.stderr.write(chunk),
    });
  } catch (error) {
    return report([], [`INVOCATION_OR_RUNNER_ERROR: ${error.message}`]);
  }
}
const entry = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (entry === import.meta.url) {
  const document = await command(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.exitCode = exitCode(document);
}
