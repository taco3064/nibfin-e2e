import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { sourceCommand } from '../../source-process.mjs';
import { sourceEnvironment } from '../../source-checkout.mjs';
import { replacementCases } from './replacement-core.mjs';

export { replacementCases };
export const replacementUnsupported = Object.freeze({
  evidence: 'unverified', code: 'REPLACEMENT_REQUIRES_LINUX',
});

export function verifyReplacement(actual, platform = process.platform) {
  if (platform !== 'linux') {
    assert.deepEqual(actual, replacementUnsupported);
    return;
  }
  assert.equal(actual.evidence, 'synthetic');
  assert.deepEqual(actual.passed, replacementCases);
}

export async function exerciseReplacement(context, signal) {
  if (process.platform !== 'linux') return { ...replacementUnsupported };
  const driver = fileURLToPath(new URL('./replacement-core.mjs', import.meta.url));
  const script = [
    "import { replacementCore } from '" + new URL('./replacement-core.mjs',
      import.meta.url).href + "';",
    'console.log(JSON.stringify(await replacementCore(',
    JSON.stringify(context.sources.core), ')));',
  ].join('\n');
  const result = await sourceCommand(process.execPath,
    ['--input-type=module', '--eval', script], {
      cwd: context.tempDir, env: sourceEnvironment(context.tempDir),
      timeoutMs: 30000, signal,
    });
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.evidence, 'synthetic', driver);
  verifyReplacement(actual);
  return actual;
}
