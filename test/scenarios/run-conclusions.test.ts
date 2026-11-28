// The R9.1 run statistics' conclusion reading (Proposal R9.1, R9.2, R9.19): a run row's
// conclusion is read from its separate text parts, so a badge directly followed by the start
// time or repository is still read as that conclusion, and a row without one names its text.
import { equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { runConclusion } from '../../scenarios/dashboard/views.ts';

const row = (word: string) => [
  'Conclusion:',
  word,
  '28 Nov 2026, 10:00',
  'taco3064/gh-nibfin',
  'Open run in GitHub',
  '/o/r/actions/runs/1',
];

test('each conclusion word followed directly by the time and repository is read as that conclusion', () => {
  const cases: [string, string][] = [
    ['success', 'success'],
    ['succeeded', 'success'],
    ['passed', 'success'],
    ['failure', 'failure'],
    ['failed', 'failure'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['skipped', 'skipped'],
    ['in progress', 'in progress'],
    ['running', 'in progress'],
    ['queued', 'in progress'],
  ];
  for (const [word, want] of cases) equal(runConclusion(row(word)), want, word);
});

test('the gate-log row form with no whitespace between parts reads as its conclusion', () => {
  equal(runConclusion(['Conclusion: ', 'success', '28 Nov 2026, 10:00', 'taco3064/gh-nibfin']), 'success');
  equal(runConclusion(['Conclusion:', 'failure', 'taco3064/gh-nibfin', '28 Nov 2026']), 'failure');
});

test('a row with no conclusion word is unknown with its text', () => {
  const got = runConclusion(['Conclusion:', '28 Nov 2026, 10:00', 'taco3064/gh-nibfin', '', '/o/r/actions/runs/1']);
  equal(got, 'unknown:Conclusion: 28 Nov 2026, 10:00 taco3064/gh-nibfin /o/r/actions/runs/1');
});

test('time, repository and link text alone are not read as a conclusion', () => {
  for (const part of ['28 Nov 2026, 10:00', 'taco3064/gh-nibfin', 'https://github.com/o/r/actions/runs/46145466465'])
    match(runConclusion([part]), /^unknown:/, part);
});
