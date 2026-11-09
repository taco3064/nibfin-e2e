# Nibfin E2E line parser

A small Node.js module used for an Owner-authorized external Nibfin delivery
verification. The repository is a real delivery target, not a claim that the
Nibfin Bootstrap or protected E2E is complete.

## Current behavior

`splitLines(text)` splits a string at LF or CRLF separators, including mixed
input. It preserves leading, consecutive and trailing empty fields, Unicode
content and line order. Empty input returns `['']`. Standalone carriage returns
remain ordinary content. Non-string input is rejected without coercion.

`countNonEmptyLines(text)` counts the nonempty fields returned by `splitLines`.
Whitespace-only fields and standalone carriage returns count as content. Empty
input, blank fields and trailing separators add nothing to the count. It rejects
non-string input without coercion.

```js
import { countNonEmptyLines, splitLines } from './src/lines.mjs';

splitLines('first\nsecond'); // ['first', 'second']
splitLines('first\r\nsecond'); // ['first', 'second']
countNonEmptyLines('\nfirst\r\n\nsecond\n'); // 2
countNonEmptyLines(' \n\t\r\n'); // 2
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
The checker covers JavaScript, workflow YAML and known JSON program manifests.
Scope authorization records and delivery artifact data are verified through
their Core contracts; they are not program source files.

Project-managed commit hooks are tracked at `.githooks/pre-commit` and
`.githooks/commit-msg`. The first runs the existing `npm run verify`; the second
requires a nonempty commit-message file and never rewrites it. Formal Shape must
enumerate these source paths and events in execution order. Nibfin executes them
in its isolated Hooks backend, independently of workstation Git configuration.

This initial repository foundation is administrative preparation. It must not
be counted as Nibfin's delivery of the later CRLF Issue. No model credentials,
Runner registrations or host authority are supplied by the source tree.
