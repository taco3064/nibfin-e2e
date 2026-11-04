# Nibfin E2E line parser

A small Node.js module used for an Owner-authorized external Nibfin delivery
verification. The repository is a real delivery target, not a claim that the
Nibfin Bootstrap or protected E2E is complete.

## Current behavior

`splitLines(text)` splits a string at LF characters, preserves empty fields and
standalone carriage returns, and rejects non-string input without coercion.
CRLF input is not yet normalized. That improvement will be a separate Issue
for Nibfin to implement through its protected delivery stages.

```js
import { splitLines } from './src/lines.mjs';

splitLines('first\nsecond'); // ['first', 'second']
```

## Development

Use Node.js 24.22.1 and npm 11.9.0. There are no third-party dependencies.

```sh
npm ci --ignore-scripts
npm run verify
```

Every program source file must remain within 90 characters per line and 1,000
lines per file. Changes go through a reviewed PR and applicable native CI.
Zero required human Approvals does not remove independent Agent review.

This initial repository foundation is administrative preparation. It must not
be counted as Nibfin's delivery of the later CRLF Issue. No model credentials,
Runner registrations or host authority are supplied by the source tree.
