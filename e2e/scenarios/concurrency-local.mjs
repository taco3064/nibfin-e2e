import { cases, assertConcurrency } from '../concurrency-assertions.mjs';
import { concurrencyFixture } from './concurrency-fixtures.mjs';

export function run() {
  return cases.map(kind => {
    const { binding, evidence } = concurrencyFixture(kind);
    return { ...assertConcurrency(binding, evidence), mode: 'fixture',
      liveVerified: false };
  });
}
export const verify = rows => rows.length === cases.length &&
  rows.every(row => row.state === 'passed' && row.mode === 'fixture' &&
    row.liveVerified === false);
