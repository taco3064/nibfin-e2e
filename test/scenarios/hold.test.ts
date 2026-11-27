import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { CI_RULESET, HOLD_PATH, installHold, removeHold } from '../../scenarios/lib/hold.ts';
import { putFile } from '../../scenarios/lib/github.ts';
import { createGitHub } from '../../src/host/github.ts';
import { RULE_VIOLATION } from '../host/fakes.ts';
import type { FakeRuleset } from '../host/fakes.ts';
import { EXEC, setup } from './kit.ts';

const ID = 42;
const RULESET = `/repos/${EXEC}/rulesets/${ID}`;
const CONTENTS = `/repos/${EXEC}/contents/${HOLD_PATH}`;

/** The sandbox with `e2e-ci` as `Kit.baseline` creates it: active, requiring `test` on the default branch. */
function withCi(enforcement = 'active') {
  const h = setup();
  const ci: FakeRuleset = {
    id: ID,
    name: CI_RULESET,
    target: 'branch',
    enforcement,
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'test' }] } } as { type: string }],
  };
  (h.repo(EXEC).rulesets as FakeRuleset[]).push(ci);
  return { h, ci };
}

/** The writes of a call, without the sandbox's other traffic. */
const writesOf = (writes: string[]) => writes.filter((w) => w.includes('/rulesets') || w.includes('/contents/'));

test('without the lift, the fake refuses the direct write as GitHub did in the gate', async () => {
  const { h } = withCi();
  await rejects(putFile(h.kit.github, EXEC, HOLD_PATH, 'x', 'm'), (e: Error) => e.message.includes(RULE_VIOLATION) && e.message.includes('409'));
});

test('with an active e2e-ci, installing and removing the hold lift the ruleset for the write and restore it to active', async () => {
  const { h, ci } = withCi();
  const before = JSON.stringify({ ...ci, enforcement: undefined });

  await installHold(h.kit.github, EXEC);
  ok(h.repo(EXEC).mainFiles.has(HOLD_PATH));
  equal(ci.enforcement, 'active');
  deepEqual(writesOf(h.fake.writes), [`PUT ${RULESET}`, `PUT ${CONTENTS}`, `PUT ${RULESET}`]);

  h.fake.writes.length = 0;
  await removeHold(h.kit.github, EXEC);
  equal(h.repo(EXEC).mainFiles.has(HOLD_PATH), false);
  equal(ci.enforcement, 'active');
  deepEqual(writesOf(h.fake.writes), [`PUT ${RULESET}`, `DELETE ${CONTENTS}`, `PUT ${RULESET}`]);

  // Only enforcement was switched: every other field is as before.
  equal(JSON.stringify({ ...ci, enforcement: undefined }), before);
  deepEqual((h.repo(EXEC).rulesets as FakeRuleset[]).map((r) => r.name), [CI_RULESET]);
});

test('with no ruleset, the hold is installed and removed by the direct write alone', async () => {
  const h = setup();
  await installHold(h.kit.github, EXEC);
  ok(h.repo(EXEC).mainFiles.has(HOLD_PATH));
  await removeHold(h.kit.github, EXEC);
  equal(h.repo(EXEC).mainFiles.has(HOLD_PATH), false);
  deepEqual(writesOf(h.fake.writes), [`PUT ${CONTENTS}`, `DELETE ${CONTENTS}`]);
  equal(h.fake.writes.some((w) => w.includes('/rulesets')), false);
});

test('an e2e-ci that is not active is left as it is', async () => {
  const { h, ci } = withCi('disabled');
  await installHold(h.kit.github, EXEC);
  ok(h.repo(EXEC).mainFiles.has(HOLD_PATH));
  equal(ci.enforcement, 'disabled');
  equal(h.fake.writes.some((w) => w.includes('/rulesets')), false);
});

test('a failing file write still restores the ruleset, and the original error is thrown', async () => {
  const { h, ci } = withCi();
  h.fake.failures.set(`PUT ${CONTENTS}`, 500);
  await rejects(installHold(h.kit.github, EXEC), (e: Error) => /PUT .*e2e-hold\.yml returned 500: refused by fake/.test(e.message) && !e.message.includes(CI_RULESET));
  equal(ci.enforcement, 'active');
  deepEqual(writesOf(h.fake.writes), [`PUT ${RULESET}`, `PUT ${CONTENTS}`, `PUT ${RULESET}`]);
});

/** A client whose ruleset PUTs after the first are answered by `restore`. */
function failingRestore(h: ReturnType<typeof setup>, restore: () => Response) {
  let puts = 0;
  return createGitHub(() => 'tok', async (input, init) => {
    if ((init?.method ?? 'GET') === 'PUT' && new URL(String(input)).pathname === RULESET && ++puts > 1) return restore();
    return h.fake.fetch(input, init);
  });
}

test('a failed restore fails plainly with the ruleset name and the enforcement read back', async () => {
  const { h, ci } = withCi();
  const gh = failingRestore(h, () => new Response(JSON.stringify({ message: 'Resource not accessible' }), { status: 403 }));
  await rejects(installHold(gh, EXEC), (e: Error) => {
    match(e.message, new RegExp(`^${CI_RULESET} on ${EXEC} reads back enforcement disabled after restore; expected active`));
    match(e.message, /restore failed .*403: Resource not accessible/);
    return true;
  });
  equal(ci.enforcement, 'disabled');
});

test('a restore that does not stick is caught by the read-back', async () => {
  const { h } = withCi();
  const gh = failingRestore(h, () => new Response(JSON.stringify({}), { status: 200 }));
  await rejects(removeHold(gh, EXEC), new RegExp(`${CI_RULESET} on ${EXEC} reads back enforcement disabled after restore; expected active`));
});

test('a failed write and a failed restore report both, with the write as the cause', async () => {
  const { h } = withCi();
  h.fake.failures.set(`PUT ${CONTENTS}`, 500);
  const gh = failingRestore(h, () => new Response(JSON.stringify({ message: 'nope' }), { status: 403 }));
  await rejects(installHold(gh, EXEC), (e: Error) => {
    match(e.message, /reads back enforcement disabled after restore; expected active/);
    match(e.message, /the write had failed: .*returned 500/);
    match(String((e.cause as Error).message), /returned 500/);
    return true;
  });
});
