import { deepEqual, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { select } from '../src/select.ts';
import { map, scenarios } from './fixtures.ts';

const ids = (r: ReturnType<typeof select>) => ({
  rules: r.selected.entries.map((e) => e.id),
  excluded: r.selected.excluded.map((e) => e.id),
  scenarios: r.selected.scenarios.map((s) => s.id),
  errors: r.errors,
});

test('--all selects every rule and scenario', () => {
  deepEqual(ids(select(map, scenarios, { all: true })), {
    rules: ['R0.1', 'R3.1', 'R3.2', 'R5.13', 'R5.14'],
    excluded: ['R0.1'],
    scenarios: ['a', 'b'],
    errors: [],
  });
});

test('--rule selects a rule and the scenarios declaring it', () => {
  deepEqual(ids(select(map, scenarios, { all: false, rules: ['R5.13'], sections: [] })), {
    rules: ['R5.13'],
    excluded: [],
    scenarios: ['b'],
    errors: [],
  });
});

test('repeated --rule and --section combine as a union in map order', () => {
  deepEqual(ids(select(map, scenarios, { all: false, rules: ['R5.14', 'R3.1', 'R3.1'], sections: ['0'] })), {
    rules: ['R0.1', 'R3.1', 'R5.14'],
    excluded: ['R0.1'],
    scenarios: ['a'],
    errors: [],
  });
  deepEqual(ids(select(map, scenarios, { all: false, rules: [], sections: ['3', '5'] })).rules, [
    'R3.1',
    'R3.2',
    'R5.13',
    'R5.14',
  ]);
});

test('unknown or malformed rule ids and empty sections are errors', () => {
  const { errors } = select(map, scenarios, { all: false, rules: ['R9.1', 'X1'], sections: ['7', '03'] });
  for (const expected of [
    /--rule R9.1: not in the coverage map/,
    /--rule X1: not a rule id/,
    /--section 7: no rules/,
    /--section 03: not a section number/,
  ]) {
    ok(
      errors.some((e) => expected.test(e)),
      `${expected} in ${errors.join('; ')}`,
    );
  }
});
