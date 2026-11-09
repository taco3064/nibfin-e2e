// Split LF and CRLF separators, preserving empty fields and standalone CR.
export function splitLines(text) {
  if (typeof text !== 'string') throw new TypeError('Expected a string');
  return text.split(/\r?\n/);
}

export function countNonEmptyLines(text) {
  return splitLines(text).filter((line) => line !== '').length;
}
