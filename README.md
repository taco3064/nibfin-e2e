# Local E2E runner foundation

This credential-free framework does not certify Nibfin support, live E2E,
GitHub delivery or releases. The `runner` group exercises actual current-main
CLI commands with controlled inputs; see [Runner scenarios](e2e/RUNNERS.md).
The [CLI onboarding contract](e2e/scenarios/cli-onboarding/README.md) uses
synthetic provider observations and does not establish live coverage.
Fixtures under `e2e/test/fixtures/` remain framework unit tests only.

Use Node 24 or later:

- `npm ci --ignore-scripts`: install from the dependency-free lockfile.
- `npm test`: run local framework tests.
- `npm run verify`: check source syntax, source size limits and run tests.
- `npm run e2e`: select all registered scenarios.
- `npm run e2e -- --group cli-onboarding`: exercise actual CLI contract logic.
- `npm run e2e:group -- NAME`: select a group.
- `npm run e2e -- --group NAME --group OTHER`: select multiple groups.

An empty selection exits 1 with a `NO_SCENARIOS` error. Unknown groups and
invalid arguments also fail. Use `npm run --silent`
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

## Run-owned product sources

`e2e/sources.mjs` exports `prepareSources()` and
`withPreparedSources(async prepared => { ... })`. Preparation acquires the three
public product repositories from their official `refs/heads/main` branches once.
These are three independent branch observations. The frozen `prepared.sources`
object contains `core`, `action` and `cli`, each with repository, URL, ref,
observed commit, checkout directory and producer output. There is no revision
configuration or fallback. A new preparation creates new checkouts.

Core runs `node scripts/package-ci.mjs` with the acquired `SOURCE_COMMIT`; its
output is the verified archive and producer pin in `distribution/`. Action runs
`npm ci --ignore-scripts`, then `npm run build`, and uses its own metadata reader
to locate the Node entry. CLI runs `go build -trimpath -o gh-nibfin .`, letting Go
honor `go.mod`. Consumer Core declarations must match the produced repository,
commit, archive and manifest identities. CLI's declared Action must also match.
The adapter never edits those declarations or installs Core on a host.

Use a retained set for both testing and later release preparation:

```js
import { withPreparedSources } from './e2e/sources.mjs';
import { run } from './e2e/runner.mjs';

await withPreparedSources(async prepared => {
  const document = await run(entries, groups, { sources: prepared.sources });
  // Later authorized release code consumes these same checkouts and outputs.
  return document;
});
```

Scenario workers receive `context.sources`; their temporary directory cleanup
leaves these run-owned checkouts intact. `prepareSources()` callers instead own
an explicit awaited `prepared.dispose()`. The callback helper disposes after
success or failure. Cleanup failures reject and identify the retained directory;
explicit disposal can be retried. Callers must await all uses before disposal.

`runPrepared` owns preparation and cleanup for one scenario run, returning
settled input failures as `SOURCE_PREPARATION_ERROR` results for affected scenarios.
Independent scenarios continue in registry order. Cleanup and unsafe termination
failures remain run-level errors. Selected requirements are immutable registry
metadata: `core-source` and `action-source` mean checkout identity; `core`,
`action`, and `cli` require prepared outputs. CLI includes Core preparation and
Action identity compatibility, without building Action. Core checkout scenarios
never read consumer pins. Local fixtures and protected-only stubs acquire nothing.
Custom entries without declarations conservatively require the full prepared set.
Explicit selected owners cannot perform release preparation. Default source owners
still prepare and validate all three producers. The production
CLI uses this entry for runnable registered scenarios. Empty selection and
policy exclusions retain their existing behavior and do not fetch sources.
The injected CLI registry remains a local framework-test seam.

Preparation child processes run outside scenario workers, in private POSIX
process groups with finite time and output limits. They are awaited before
cleanup; timeout terminates the group. This implementation requires POSIX
process-group support and rejects Windows preparation explicitly. It requires
Git, the producer-declared Node/npm and Go tools, and permitted dependency
access. It inherits no Git credentials or Git configuration. All temporary
homes, build caches and outputs belong to the disposable run directory.

Tests inject checkout/preparation functions or command execution through the
library options; production URLs and branch selection have no user overrides.
These credential-free tests include producer failure, pin incompatibility,
upstream movement, source lifetime and real local process cleanup. They do not
establish live three-product compatibility, protected execution or release
coverage. Registered controlled Runner and CLI onboarding scenarios remain
separate from live E2E.

## Read-only GitHub observations

`e2e/github-transport.mjs` exports `githubTransport({ token, fetcher })`.
Tokens are supplied explicitly; the transport only performs GET requests to
`https://api.github.com`, rejects redirects, and returns no raw error body.
`fetcher` defaults to native fetch. No network or credentials are required for
fake-provider tests. An injectable provider has signature
`async (url, { signal }) => ({ status, headers, data })`, where headers may be
native Headers or a lowercase-key object and data is parsed native GitHub JSON.
Providers should honor abort signals; the observer bounds its own wait even
when a provider does not. Callers remain responsible for provider resources.

`githubObserver(provider, options)` from `e2e/github-observer.mjs` returns
`observe(target, expected?)`. Targets always include `repository: 'owner/repo'`
and one of these explicit resource identities:

- `kind: 'issue'` or `'pull'`, with positive `number`.
- `kind: 'run'`, with positive `runId`; optional `attempt` and `sha` constrain it.
- `kind: 'jobs'`, with `runId` and `attempt`; optional `sha` constrains every job.
- `kind: 'checks'`, with the full commit `sha`.

Collections use 100 items per page and require stable total counts, unique
identities and complete pagination. Unsafe links, mismatches and truncated
collections remain incomplete. Native objects are transient observations, not
a lifecycle database. Options are positive integers: `maxRequests` (50),
`maxPages` per snapshot (10), `timeoutMs` (30000), `requestTimeoutMs` (5000),
and `intervalMs` (250). Requests, pages, retry waits and polling share the
same request and elapsed-time budgets. Retry-After and quota reset headers
are honored when their wait fits that budget.

Without an expectation, observation returns a single bounded snapshot with
`target`, `complete`, `data` on success or a sanitized `reason` on inability,
and `requests`. With an expectation, observation polls unknown evidence until
it resolves or exhausts the budget and also returns `assertion`. Exhaustion
is incomplete even if the last snapshot contained some objects.

`assertObservation(observation, expected)` in `e2e/github-assertions.mjs`
returns `{ state, reason }`, with state `satisfied`, `contradicted`, or `unknown`.
Expectations are `{ merged: true }` for PRs, `{ closed: true }` for Issues
(optionally `stateReason: 'completed'`), or `{ conclusion: 'success' }` for
runs. Jobs and Checks additionally require explicit `ids: [123, 456]`.
No check names, approvals, protection rules or delivery gates are inferred.
Missing objects and pending work remain unknown; completed contrary outcomes
are contradictions. Native merge and closure fields are evaluated separately.

Scenarios may use `confirmed(assertion)` as their final boolean confirmation
only after all of their required observations/assertions have completed.
For example, a scenario can return the result of
`observe({ repository: 'owner/repo', kind: 'pull', number: 42 }, { merged: true })`
and implement `verify(actual)` as `return confirmed(actual.assertion)`.
Local contract tests demonstrate library behavior only; live-provider E2E,
support certification, release and publication remain unverified here.

### Disposable repository provisioning

Protected operations can compose `repositoryDefinition(account, repository)` from
`e2e/repository-definition.mjs`, `fixtureInventory`, `fixtureGithub` and
`repositoryLifecycle` from `e2e/repository-lifecycle.mjs`. The account is an
explicitly authorized disposable **User** account (`id`, `login`); `repository`
is the existing credential-validation repository, not a provisioning target.
The authenticated User must be that disposable account. This interface does not
provision organization repositories or expose Installation helper credentials.

Persist the returned definition in protected run state and reuse it unchanged
when reopening the inventory. Its two random run-specific names, ownership
marker and account are saved in the inventory before creation. Keep inventory
outside the disposable worker root. Supply protected `context.authorize` for
each operation and `context.idle` to confirm prior producers have stopped before
recovery. A lost creation response additionally requires `context.receipt` to
return `{ operation, native }` from protected native evidence bound to the exact
creation intent; resource names and markers alone cannot supply that evidence.
These callbacks are capabilities supplied by the trusted operations composition,
never scenario input or environment credential discovery.

`provision()` returns `state`, the inventory path and both repository records.
Each record retains its intended name, account, marker, creation operation,
creation settlement, seed settlement and acknowledged native identity. Native
identity includes the full name, positive repository ID, owner and default
branch. Installation consumers must require `state === 'ready'`; teardown
consumers must retain every record, including unresolved effects. This module
performs no installation or teardown.

Seeds are maintained in `repositorySeed`: a small deterministic Node project
with an exported greeting and an executable test. A single non-force default
branch update publishes all project files. Read-back verifies their content at
one observed commit. Unknown creation is never replayed, and unknown seed writes
must be observed before any more writes to that repository. An absent or
contradictory observation remains unresolved. Local provider-seam tests certify
implementation behavior only; real provider creation and installation require
the later authorized operations route.

### Controlled Claude delivery

`npm run e2e -- --group claude-delivery` uses the scenario owner's separately
prepared Core source. The `delivery.claude.fixture` entry composes a Claude-selected
shared A/B pool with the existing simulated suite's provision, install, delivery
and cleanup phases. The existing Codex suite and its failed-CI lifecycle remain
separate regressions. Producer compatibility checks and declarations are unchanged.

The maintained `ClaudeRoleAgent`, private model runner, role plans, structured
parser and stage decisions govern Shape, independent validation, Deliver, Accept
and final review. A bounded local Node executable supplies controlled model output
at the process boundary. Docker inspections, credentials, work effects, checks,
publication, merge and closure are synthetic. This is component regression evidence;
it does not establish production Claude composition, installation or live readiness.
Only Deliver's maintained work plan grants Candidate writes. No live credentials
are accepted or forwarded to the executable double.

Composition bounds cover all model processes in the paired delivery request and
leave the enclosing suite time for producer settlement and cleanup. Individual
model processes retain their five-second limit. Unknown work still retains the
inventory lock and recovery resources; increasing the bound never breaks a lock.

The regression checks exact merged JavaScript stdout, invalid output, a settled
process timeout, safely settled interruption, unknown model settlement and a lost
reply after committed effects. Continuation requires current fixture authorization
and separate settlement evidence, preserves confirmed stages and the Agent binding,
and starts the unfinished role with a fresh execution/session. Unknown settlement
retains owned resources; committed-effect reconciliation only reads existing results.
No replacement PR, repeated merge or Codex fallback is authorized by these controls.

Focused tests can consume an already prepared Core checkout without acquiring or
modifying it:

```sh
NIBFIN_TEST_CORE=/path/to/prepared/core \
NIBFIN_TEST_CORE_COMMIT=<observed-source-commit> \
node --test e2e/test/claude-delivery.test.mjs
```

`npm run verify`, including PR verification, acquires maintained Core main through
the existing source acquisition owner when those inputs are absent. Acquisition
failure fails verification; the three component integration tests cannot silently
skip in that command. Its temporary Core checkout is removed after the tests.
Direct `node --test` without prepared inputs still reports component tests skipped.
Run requests cannot supply these composition capabilities. Executable
doubles, isolated fixture trees and settled sessions are removed by their owners;
prepared producer sources remain owned by the existing source lifecycle.

## Simulated lifecycle CLI

Run the complete maintained offline lifecycle with a durable local session:

```sh
node e2e/cli.mjs --suite --run-id demo --state-dir ./simulation-state
```

Use `--phase provision|install|delivery|failure|cleanup` to select one phase and
`--resume` for subsequent processes using the same run ID and state directory.
See [suite usage](e2e/SUITE.md) and [simulation recovery](e2e/SIMULATION.md).
All GitHub and host effects in this command family are simulated; the harmless
merged JavaScript fixtures execute locally. These results are controlled evidence.

### Automatic suite failure investigation

Full and selected-phase suite requests now include an `investigation` result
separate from the test outcome, cleanup and process exit status. After session
settlement, a non-passing request automatically attempts investigation. Passing
selected phases do not investigate unrequested later phases. Raw diagnostics,
resource identifiers and provider replies are not sent to the model.

The ordinary controlled CLI has no model, GitHub publisher or installed wake
credentials. It reports `AUTHORIZED_MODEL_UNAVAILABLE` on a failing request.
This is an explicit unavailable prerequisite, not a confirmed defect, successful
publication, or live E2E claim. Non-suite commands retain their existing behavior.

Owner-authorized programmatic composition can use
`e2e/defect-composition.mjs`'s `failureInvestigation` and pass its result as the
third argument of `command(args, entries, investigation)` or the second argument
of `suiteCommand(args, investigation)`. No report field, persisted session, CLI
option or repository instruction can load a provider or select a target.
The composition supplies:

- `configuration`: approved public repository names and numeric IDs in `targets`,
  the approved assignee's numeric ID and login, and the `scope` label.
- `model`: an authorized `invoke` facility with enforced read-only isolation,
  private model authentication and cancellation support; `observe` reads current
  owning source, relevant callers and open/closed Issues from an allowlist;
  `approvePublic` independently approves each observation for disclosure.
  The E2E adapter permits at most 40 reads, 16 KB per observation, a 64 KB model
  response and a bounded invocation timeout. It supplies Scope in Plan mode.
- `publication`: a private GitHub token and optional trusted fetch transport.
  The token is held only by the publisher adapter. No model tool receives it.
- `assess`: an independent trusted assessment of code grounding, English content,
  disclosure, semantic identity, necessary change and refreshed duplicate Issues.
  It returns `publicSafe`, `english`, `codeBacked`, the verified semantic `key`
  and `duplicate` (`none`, `existing`, `addressed` or `recurrence`). Reusing
  existing work additionally binds its number, `existingId`, `existingTitle`
  and `existingBody`; recurrence requires `newMaintainedChange`. This assessment
  cannot be supplied by the investigating model or the run report.
- `stateDir` outside the model's `modelRoot`, owned by protected composition.
  Both directories must be disjoint. Keep the publication journal across runs.
- Optional `wake` capabilities bound to the installed Core's authorized wake
  route: `requestWake` and `reconcileWake`. Both receive only verified Issue
  locators. Reconciliation uses Core's native dispatch journal and readback,
  including its actual `scheduled`/`denied`/`skipped`/`pending` disposition.
  Positive journal absence must be explicit; an HTTP acknowledgement is never
  evidence of dispatch. Core retains all adoption, approval, pause, dependency,
  assignee and Runner admission checks. Missing wake capability remains visible.

Investigation independently acquires official Core main using the existing
credential-free bounded source process, reads its maintained Scope Skill and
records that observed revision. It does not replace installed Core or relabel
controlled recovery sources as official acquisitions. Acquisition and invocation
failures leave the original suite result intact. Source checkouts are removed
when process termination is known; unknown termination retains recovery material.

Findings require a behavior identifier, owning source, semantic `changeIdentity`,
necessary change, evidence IDs for source/callers/Issues, duplicate assessment,
and actionable English title/body. Publication independently validates these
fields and the approved repository, assignee and label before any write. A
semantic tuple of repository, owning source, behavior and change identity keys
reconciliation across runs; run IDs, timestamps and diagnostic wording do not.
A confirmed recurrence needing a different maintained change has its own verified
semantic change identity. Addressed duplicates do not create or reopen work.

The durable journal persists intent before create and wake operations. Repeated
and concurrent runs reuse verified Issues. Lost create replies reconcile using a
stable Issue marker; incomplete observations, conflicting matches, changed
protected content and unknown effects remain pending. Unknown creates are never
blindly retried. Closed Issues are never reopened or automatically rewritten.
Unknown wake effects reconcile through Core before any further dispatch.
Locks are exclusive and are never retired by age. Keep journals and unresolved
locks until protected recovery establishes ownership and external effects; they
are operational recovery resources, not Candidate artifacts.

Controlled tests exercise these boundaries with model, GitHub and wake doubles.
They establish no live provider, host installation, release or platform support.
