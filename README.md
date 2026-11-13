# Local E2E runner foundation

This credential-free framework does not certify Nibfin support, live E2E,
GitHub delivery or releases. Production registration in `e2e/registry.mjs` is
currently empty. Synthetic fixtures under `e2e/test/fixtures/` are used only
by the unit tests and never registered as production coverage.

Use Node 24 or later:

- `npm ci --ignore-scripts`: install from the dependency-free lockfile.
- `npm test`: run local framework tests.
- `npm run verify`: check source syntax, source size limits and run tests.
- `npm run e2e`: select all registered production scenarios.
- `npm run e2e:group -- NAME`: select a group.
- `npm run e2e -- --group NAME --group OTHER`: select multiple groups.

With the empty production registry, the runner exits 1 with a `NO_SCENARIOS`
error. Unknown groups and invalid arguments also fail. Use `npm run --silent`
when redirecting npm command output to a JSON consumer (npm otherwise prints
its own command banner). Direct `node e2e/cli.mjs` emits only JSON to stdout.
Scenario diagnostics are drained separately and forwarded to stderr.

## Registration and execution

`register` validates metadata using the authoritative `metadataSchema` in
`e2e/schema.mjs`. Fields are `id`, `group` (lowercase alphanumeric identifiers
with dot/hyphen separators), nonempty `title`, integer `timeoutMs` from 1 to
2147483647, absolute file URL `module`, and optional nonempty `policyReason`.
Unknown fields and duplicate IDs are rejected. Selection sorts by ID and runs
each selected scenario once, independent of registration or group order.

Each module exports `run(context)` and `verify(actual, context)`; either may
be async. `context.tempDir` is a unique runner-owned directory. `verify` must
complete all required assertions and return exactly `true`. Exceptions fail;
a missing implementation or absent assertion confirmation is unverified.
Optional `prerequisite(context)` returns exactly `true` or a nonempty reason
for a blocked result. Policy exclusion prevents module loading entirely.

Execution runs sequentially in disposable Node worker threads. The finite
metadata timeout covers module import, prerequisites, execution and assertions.
The first terminal event wins. Workers are terminated and termination is awaited
before recursive directory removal, including success, error and timeout paths.
Cleanup failures override success and expose the retained directory in the reason.
These workers isolate lifecycle and output; they are not a security sandbox.
Modules are maintained, trusted local code and must not spawn detached processes,
create resources outside their directory or launch external work. Future live
provider/process execution needs its own authorized resource management.

## JSON results, version 1

The authoritative serializer is `e2e/schema.mjs`. Every document has
`schemaVersion: 1`, `results: []`, and `errors: []` (runner/invocation error strings).
Each selected result contains `id`, `group`, `outcome`, and
`reason: { code, message }`. Outcomes are `passed`, `failing`,
`skipped-by-policy`, `blocked`, and `unverified`. Codes distinguish assertion
completion, policy, missing prerequisites, unsupported execution, early exit,
timeout, execution errors, infrastructure errors and cleanup errors.

Exit status is 0 only for a nonempty selection consisting entirely of passed
or policy-skipped scenarios with no runner errors; otherwise it is 1. Policy
skips remain explicit and convey no verification. Blocked and unverified results
are also non-passing, even when other scenarios pass. Results contain no live
coverage claims. Full Git-dependent PR checks and independent acceptance belong
to the existing protected process; local verification cannot substitute for them.
