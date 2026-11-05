import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLines } from '../src/lines.mjs';

test('splits LF-separated lines', () => {
  assert.deepEqual(splitLines('first\nsecond'), ['first', 'second']);
});

test('splits CRLF and mixed LF/CRLF separators', () => {
  assert.deepEqual(splitLines('first\r\nsecond'), ['first', 'second']);
  assert.deepEqual(splitLines('a\nb\r\nc'), ['a', 'b', 'c']);
});

test('preserves empty input, blank lines and terminal empty fields', () => {
  assert.deepEqual(splitLines(''), ['']);
  assert.deepEqual(splitLines('\nfirst\n\n'), ['', 'first', '', '']);
  assert.deepEqual(splitLines('\r\nfirst\r\n\r\n'), ['', 'first', '', '']);
  assert.deepEqual(splitLines('\n\r\n'), ['', '', '']);
  assert.deepEqual(splitLines('first\r\n'), ['first', '']);
  assert.deepEqual(splitLines('first\n'), ['first', '']);
});

test('preserves a standalone carriage return as ordinary content', () => {
  assert.deepEqual(splitLines('first\rsecond'), ['first\rsecond']);
  assert.deepEqual(splitLines('first\r'), ['first\r']);
  assert.deepEqual(splitLines('a\r\r\nb'), ['a\r', 'b']);
});

test('preserves Unicode content and order across mixed separators', () => {
  assert.deepEqual(splitLines('café\r\n日本語😀\n𝄞fin'), ['café', '日本語😀', '𝄞fin']);
});

test('rejects non-string input without coercion', () => {
  for (const value of [undefined, null, 12, {}, ['first'], new String('first'),
    true, 12n, Symbol('first')]) {
    assert.throws(() => splitLines(value), TypeError);
  }
});

test('does not invoke conversion methods on rejected input', () => {
  let conversions = 0;
  const convert = () => {
    conversions += 1;
    return 'first\r\nsecond';
  };
  const value = {
    [Symbol.toPrimitive]: convert,
    toString: convert,
    valueOf: convert,
  };
  assert.throws(() => splitLines(value), TypeError);
  assert.equal(conversions, 0);
});
