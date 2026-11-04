import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLines } from '../src/lines.mjs';

test('splits LF-separated lines', () => {
  assert.deepEqual(splitLines('first\nsecond'), ['first', 'second']);
});

test('preserves empty input, blank lines and terminal empty fields', () => {
  assert.deepEqual(splitLines(''), ['']);
  assert.deepEqual(splitLines('\nfirst\n\n'), ['', 'first', '', '']);
});

test('preserves a standalone carriage return as ordinary content', () => {
  assert.deepEqual(splitLines('first\rsecond'), ['first\rsecond']);
});

test('rejects non-string input without coercion', () => {
  for (const value of [undefined, null, 12, {}, ['first']]) {
    assert.throws(() => splitLines(value), TypeError);
  }
});
