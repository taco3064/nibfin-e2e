import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { buttonNamesFromAriaSnapshot, missingButtonMessage } from '../../scenarios/dashboard/checks.ts';
import {
  REPO_OPERATION,
  RUNNER_ADD,
  RUNNER_LOGIN,
  RUNNER_REMOVE,
  repoViewOf,
} from '../../scenarios/dashboard/operations.ts';

test('the Runner add matcher accepts add as a whole word anywhere in the name', () => {
  for (const name of ['Add', 'Runner add', 'Add runner', '+ Add runner', 'runner-add']) ok(RUNNER_ADD.test(name), name);
  for (const name of ['Address', 'Padding', 'Added', 'Readd']) ok(!RUNNER_ADD.test(name), name);
});

test('the Runner remove matcher accepts remove as a whole word anywhere in the name', () => {
  for (const name of ['Remove', 'Runner remove', 'Remove runner', '− Remove runner'])
    ok(RUNNER_REMOVE.test(name), name);
  for (const name of ['Removed', 'Removal', 'Unremovable']) ok(!RUNNER_REMOVE.test(name), name);
});

test('the Runner login matcher accepts login or log in as a whole word anywhere in the name', () => {
  for (const name of ['Login', 'Log in', 'Claude login', 'Re-login']) ok(RUNNER_LOGIN.test(name), name);
  for (const name of ['Logged in', 'Blogin', 'Catalogin']) ok(!RUNNER_LOGIN.test(name), name);
});

test('the repo-view operation matchers take Init and Upgrade at the start of the name', () => {
  for (const name of ['Init', 'init', 'Init repository']) ok(REPO_OPERATION.init.test(name), name);
  for (const name of ['Initialized', 'Re-init', 'Upgrade']) ok(!REPO_OPERATION.init.test(name), name);
  for (const name of ['Upgrade', 'upgrade image']) ok(REPO_OPERATION.upgrade.test(name), name);
  for (const name of ['Upgraded', 'Init']) ok(!REPO_OPERATION.upgrade.test(name), name);
});

test('a repo-view lookup names the repository selected', () => {
  equal(repoViewOf('o/r'), 'the repo view of o/r');
});

test('button names come from the button lines of an aria snapshot', () => {
  const snapshot = [
    '- banner:',
    '  - heading "Runners" [level=1]',
    '  - button "Refresh"',
    '- main:',
    '  - button "+ Add runner" [disabled]',
    '  - link "Login"',
    '  - button',
    '  - textbox "Search"',
    '  - button "Log in":',
    '    - img',
  ].join('\n');
  deepEqual(buttonNamesFromAriaSnapshot(snapshot), ['Refresh', '+ Add runner', '(unnamed)', 'Log in']);
  deepEqual(buttonNamesFromAriaSnapshot(''), []);
});

test('the missing-button message keeps its prefix and lists the buttons shown', () => {
  const prefix = 'R9.12: expected a /\\badd\\b/i button in the runner view; observed none';
  equal(
    missingButtonMessage('R9.12', RUNNER_ADD, 'the runner view', ['Refresh', 'Log in']),
    `${prefix}; buttons shown: "Refresh", "Log in"`,
  );
  equal(missingButtonMessage('R9.12', RUNNER_ADD, 'the runner view', []), `${prefix}; no buttons shown`);
  equal(
    missingButtonMessage('R9.12', RUNNER_ADD, 'the runner view', undefined),
    `${prefix}; the buttons shown could not be read`,
  );
});

test('the missing-button message collapses, trims and caps the names shown', () => {
  const long = `  Start   ${'x'.repeat(80)}\n`;
  const many = [long, ...Array.from({ length: 19 }, (_, i) => `B${i}`)];
  const m = missingButtonMessage('R9.21', /^x$/, 'the Runner view', many);
  ok(m.startsWith('R9.21: expected a /^x$/ button in the Runner view; observed none; buttons shown: "Start xxx'), m);
  const first = /buttons shown: "([^"]*)"/.exec(m)?.[1] ?? '';
  equal(first.length, 40);
  ok(first.endsWith('…'));
  ok(m.includes('"B13"') && !m.includes('"B14"'), m);
  ok(m.endsWith(' … and 5 more'), m);
});
