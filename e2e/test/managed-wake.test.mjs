import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prerequisite, verify } from '../scenarios/managed-wake/contract.mjs';
import { requiredCases } from '../scenarios/managed-wake/cases.mjs';
import { scenarios, select } from '../registry.mjs';
import { execute } from '../execution.mjs';

const scenario = select(scenarios, ['managed-wake'])[0];
test('managed wake runs independently and requires producer inputs', async () => {
  assert.equal(scenario.id, 'managed-wake.contract');
  const result = await execute(scenario);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason.code, 'PREREQUISITE_MISSING');
});
test('incompatible Core declaration is an unavailable prerequisite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-prerequisite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'internal/cli'), { recursive: true });
  const entry = join(root, 'entry');
  await writeFile(entry, 'synthetic');
  await writeFile(join(root, 'internal/cli/producers.json'),
    JSON.stringify({ core: { commit: 'old' } }));
  const result = await prerequisite({ sources: {
    cli: { checkout: root, output: { entry } },
    core: { checkout: root, commit: 'current', output: { pin: { commit: 'current' } } },
  } });
  assert.equal(typeof result, 'string');
  assert.match(result, /unavailable/);
});
test('a partial case inventory cannot report managed wake success', () => {
  assert.ok(requiredCases.length >= 18);
  assert.equal(new Set(requiredCases).size, requiredCases.length);
  assert.throws(() => verify({ evidence: 'synthetic', passed: requiredCases.slice(1) }));
  assert.throws(() => verify({ evidence: 'live', passed: requiredCases }));
});
