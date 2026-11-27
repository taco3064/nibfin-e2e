import { deepEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { authorityCitations, parseShapeLine } from '../../src/gate/citations.ts';
import type { MapEntry } from '../../src/types.ts';

test('the Shape line: ids, none, missing, malformed and duplicated', () => {
  deepEqual(parseShapeLine('<!-- nibfin:shape -->\n## Goal\n\nProposal rules: R5.12, R5.14\n'), { state: 'line', ids: ['R5.12', 'R5.14'] });
  deepEqual(parseShapeLine('Proposal rules: R0.1\r\nmore'), { state: 'line', ids: ['R0.1'] });
  deepEqual(parseShapeLine('Proposal rules: R3.2, R3.2'), { state: 'line', ids: ['R3.2'] });
  deepEqual(parseShapeLine('x\nProposal rules: none\n'), { state: 'none' });
  deepEqual(parseShapeLine('no line here\n  Proposal rules: R1.1'), { state: 'missing-line' });
  for (const bad of ['Proposal rules: R5.12–R5.14', 'Proposal rules: R5.12,R5.14', 'Proposal rules: §5', 'Proposal rules: ', 'Proposal rules: R05.1', 'Proposal rules: R5.12 ', 'Proposal rules: none, R1.1']) {
    deepEqual(parseShapeLine(`a\n${bad}\nb`), { state: 'malformed-line', text: bad });
  }
  deepEqual(parseShapeLine('Proposal rules: R1.1\nProposal rules: R1.2'), { state: 'malformed-line', text: 'Proposal rules: R1.1\nProposal rules: R1.2' });
});

const entries: MapEntry[] = [
  { id: 'R3.1', notE2e: 'x' },
  { id: 'R3.2', platforms: ['linux'], scenarios: [] },
  { id: 'R3.10', platforms: ['linux'], scenarios: [] },
  { id: 'R4.1', platforms: ['linux'], scenarios: [] },
  { id: 'R8.12', notE2e: 'y' },
  { id: 'R8.15', platforms: ['linux'], scenarios: [] },
  { id: 'R8.20', platforms: ['linux'], scenarios: [] },
  { id: 'R8.21', platforms: ['linux'], scenarios: [] },
];

test('authority citations: ids, ranges, sections and section ranges, in map order, unknown ids kept', () => {
  const body = [
    '## Outcome',
    'R4.1 is mentioned here but not under Authority.',
    '## Authority',
    '',
    'Proposal R8.15, R9.99 and R3.10 (see §3); R8.12–R8.20.',
    '## Estimate',
    'R8.21',
  ].join('\n');
  deepEqual(authorityCitations(body, entries), { ids: ['R3.1', 'R3.2', 'R3.10', 'R8.12', 'R8.15', 'R8.20', 'R9.99'], sections: [3] });
  deepEqual(authorityCitations('## Authority\nProposal §3–§4, R8.20-R8.21', entries).ids, ['R3.1', 'R3.2', 'R3.10', 'R4.1', 'R8.20', 'R8.21']);
  deepEqual(authorityCitations('## Authority\nR3.2–R4.1 and xR8.15', entries).ids, ['R3.2', 'R4.1']);
  deepEqual(authorityCitations('## Authority\n', entries), { ids: [], sections: [] });
  deepEqual(authorityCitations('Proposal R3.2 without a heading', entries), { ids: [], sections: [] });
});
