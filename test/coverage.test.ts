import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { computeCoverage, crossCheck, loadMap, parseRuleId, validateMap, validateRegistry } from '../src/coverage.ts';
import { provisioning, scenarios as registered } from '../src/registry.ts';
import { map, passed, scenario, scenarioA, scenarios, step } from './fixtures.ts';

test('parseRuleId accepts R<section>.<n> only', () => {
  deepEqual(parseRuleId('R5.12'), { section: 5, n: 12 });
  deepEqual(parseRuleId('R0.1'), { section: 0, n: 1 });
  for (const bad of ['R5', 'R5.0', 'R05.1', 'r5.1', 'R5.1 ', 'R-1.2', 5]) equal(parseRuleId(bad), undefined, String(bad));
});

test('validateMap accepts a well-formed map', () => {
  deepEqual(validateMap(map), { entries: map, errors: [] });
});

test('validateMap reports each malformed entry', () => {
  const cases: [unknown, RegExp][] = [
    [{}, /must be an array/],
    [[{ id: 'R1', platforms: ['linux'], scenarios: [] }], /id must match/],
    [[{ id: 'R1.1', platforms: ['linux'], scenarios: [] }, { id: 'R1.1', notE2e: 'x' }], /duplicate id/],
    [[{ id: 'R1.1', platforms: [], scenarios: [] }], /platforms must be a non-empty array/],
    [[{ id: 'R1.1', platforms: ['bsd'], scenarios: [] }], /unknown platform "bsd"/],
    [[{ id: 'R1.1', platforms: ['linux'] }], /exactly one of/],
    [[{ id: 'R1.1', platforms: ['linux'], scenarios: [], notE2e: 'x' }], /unexpected key "platforms"/],
    [[{ id: 'R1.1', notE2e: ' ' }], /non-empty reason/],
    [[{ id: 'R1.1', platforms: ['linux'], scenarios: ['a', 'a'] }], /duplicate scenario id/],
    [['R1.1'], /must be an object/],
  ];
  for (const [raw, expected] of cases) {
    const { entries, errors } = validateMap(raw);
    deepEqual(entries, []);
    ok(errors.some((e) => expected.test(e)), `${JSON.stringify(raw)} -> ${errors.join('; ')}`);
  }
});

test('validateRegistry reports duplicates, bad rule ids and unknown steps', () => {
  deepEqual(validateRegistry(scenarios, []), []);
  const errors = validateRegistry(
    [scenario('a', ['R3.1'], ['linux'], passed, ['missing']), scenario('a', ['bad'], [], passed)],
    [step('s', passed), step('s', passed)],
  );
  for (const expected of [/step s: duplicate id/, /scenario a: duplicate id/, /malformed rule id "bad"/, /at least one platform/, /unknown provisioning step missing/]) {
    ok(errors.some((e) => expected.test(e)), `${expected} in ${errors.join('; ')}`);
  }
});

test('crossCheck passes when map and registry agree', () => {
  deepEqual(crossCheck(map, scenarios), []);
});

test('crossCheck reports every inconsistency', () => {
  const errors = crossCheck(
    [
      { id: 'R0.1', notE2e: '文件定位' },
      { id: 'R3.1', platforms: ['linux'], scenarios: ['ghost', 'b'] },
      { id: 'R3.2', platforms: ['linux'], scenarios: [] },
    ],
    [scenario('a', ['R3.2', 'R0.1', 'R9.9'], ['linux'], passed), scenario('b', ['R3.2'], ['linux'], passed)],
  );
  for (const expected of [
    /R3.1: lists unknown scenario ghost/,
    /R3.1: scenario b does not declare R3.1/,
    /scenario a: declares R3.2, but the map does not list it/,
    /scenario a: declares R0.1, which the Proposal marks 不測/,
    /scenario a: declares R9.9, which is not in the coverage map/,
  ]) {
    ok(errors.some((e) => expected.test(e)), `${expected} in ${errors.join('; ')}`);
  }
});

test('computeCoverage counts a rule only when every required platform has a scenario', () => {
  deepEqual(computeCoverage(map, scenarios), {
    covered: 3,
    total: 4,
    percent: 75,
    uncovered: [{ id: 'R5.14', missingPlatforms: ['macos'] }],
  });
  const linuxOnly = computeCoverage(map, [scenarioA]);
  deepEqual(linuxOnly.uncovered.map((u) => [u.id, u.missingPlatforms]), [
    ['R3.2', ['windows']],
    ['R5.13', ['windows']],
    ['R5.14', ['macos']],
  ]);
  equal(computeCoverage([{ id: 'R0.1', notE2e: 'x' }], []).percent, 100);
});

test('the real coverage map is valid and consistent with the real registry', () => {
  const { entries, errors } = loadMap(new URL('../coverage-map.json', import.meta.url));
  deepEqual(errors, []);
  ok(entries.length > 0);
  deepEqual(validateRegistry(registered, provisioning), []);
  deepEqual(crossCheck(entries, registered), []);
});

test('loadMap reports an unreadable file', () => {
  match(loadMap(new URL('./missing.json', import.meta.url)).errors[0] ?? '', /cannot read/);
});

test('a provisioning step may require only earlier steps', () => {
  const steps = [step('b', passed, undefined, { requires: ['a'] }), step('a', passed)];
  deepEqual(validateRegistry([], steps), ['provisioning step b: requires a, which is not an earlier step']);
  deepEqual(validateRegistry([], [...steps].reverse()), []);
});
