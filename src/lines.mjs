// Preserve empty fields and all characters other than the LF separator.
export function splitLines(text) {
  if (typeof text !== 'string') throw new TypeError('Expected a string');
  return text.split('\n');
}
