import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { HOLD_PATH, installHold, removeHold } from '../../scenarios/lib/hold.ts';
import { EXEC, setup } from './kit.ts';

const CONTENTS = `/repos/${EXEC}/contents/${HOLD_PATH}`;

/** The writes of a call, without the sandbox's other traffic. */
const writesOf = (writes: string[]) => writes.filter((w) => w.includes('/rulesets') || w.includes('/contents/'));

test('the hold is installed and removed by the direct write alone', async () => {
  const h = setup();
  await installHold(h.kit.github, EXEC);
  ok(h.repo(EXEC).mainFiles.has(HOLD_PATH));
  await removeHold(h.kit.github, EXEC);
  equal(h.repo(EXEC).mainFiles.has(HOLD_PATH), false);
  deepEqual(writesOf(h.fake.writes), [`PUT ${CONTENTS}`, `DELETE ${CONTENTS}`]);
});

test('a failed hold write fails with the GitHub error', async () => {
  const h = setup();
  h.fake.failures.set(`PUT ${CONTENTS}`, 500);
  await rejects(installHold(h.kit.github, EXEC), /PUT .*e2e-hold\.yml returned 500: refused by fake/);
  equal(h.repo(EXEC).mainFiles.has(HOLD_PATH), false);
});
