import test from 'node:test';
import assert from 'node:assert/strict';
import { countNonEmptyLines, splitLines } from '../src/lines.mjs';

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

test('counts zero for empty input and empty fields', () => {
  for (const text of ['', '\n', '\r\n', '\n\r\n']) {
    assert.equal(countNonEmptyLines(text), 0);
  }
});

test('counts content across mixed separators and blank fields', () => {
  assert.equal(countNonEmptyLines('a\nb\r\nc'), 3);
  assert.equal(countNonEmptyLines('\na\r\n\nb\r\n'), 2);
});

test('does not count trailing separators', () => {
  for (const text of ['a\n', 'a\r\n', 'a\n\r\n\n', 'a\r\n\r\n']) {
    assert.equal(countNonEmptyLines(text), 1);
  }
});

test('counts whitespace, standalone carriage returns and Unicode as content', () => {
  assert.equal(countNonEmptyLines(' \n\t\r\n'), 2);
  assert.equal(countNonEmptyLines('\r'), 1);
  assert.equal(countNonEmptyLines('a\r\r\nb'), 2);
  assert.equal(countNonEmptyLines('café\r\n日本語😀\n𝄞fin'), 3);
});

test('counter rejects non-string input without coercion', () => {
  for (const value of [undefined, null, 12, true, {}, [], new String('first'),
    12n, Symbol('first')]) {
    assert.throws(() => countNonEmptyLines(value), TypeError);
  }
});

test('counter does not invoke conversion methods on rejected input', () => {
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
  assert.throws(() => countNonEmptyLines(value), TypeError);
  assert.equal(conversions, 0);
});
