# Fresh protected delivery

`runDelivery(request, caller, bounds)` in `delivery-protected.mjs` runs outside
ordinary workers. Request fields are `repository`, relative `path`, and exact
`content`. The scenario creates a fresh UUID ownership definition and request ID,
creates one new Issue through the existing fixture lifecycle, writes a scoped
request under that definition's generated root, triggers the authorized event,
and separately correlates wake and complete delivery observations. It never
publishes or authorizes stages itself. Request maintained source with meaningful
behavior; generated reports or empty changes do not satisfy Candidate evidence.

For live mode, the existing `prepareSources` mechanism acquires current
main of Core, Action and CLI once. The protected trigger receives these prepared
`sources` and `sourceRoot` alongside the binding. Before triggering native work,
record the source root in the protected recovery inventory. Successful idle
teardown permits disposal; unresolved teardown defers disposal and reports
`sourceCleanup: deferred`. Source disposal failure reports
`sourceCleanup: unresolved` and prevents success. The protected caller later
retires retained sources after confirming actual native use has ended. It must execute
those sources through the existing authorized runner mechanism; unavailable or
incompatible installation is a capability gap, never permission to update a host.
No second version catalog or worker capability channel is introduced.

The registry's `delivery.live` entry intentionally blocks in ordinary workers:
there is no protected caller or receipt reader there. Select it with group
`delivery`. Invoke the library from the existing protected runner/release caller
for real execution. Do not put callbacks, host paths, credentials or receipts in
Issue text, CLI worker inputs or public diagnostics.

## Caller methods

JSDoc types live in `delivery-contract.mjs`. Every callback receives an abort
signal; observers/readers must honor it and return bounded complete snapshots.
The scenario has finite request and timeout bounds, performs no blind retry and
does not poll indefinitely. A reader can wait within the supplied budget;
incomplete work remains unverified and can be observed by the existing recovery
process. The caller is responsible for protected provenance and authorization.
JSON passed to this library does not authenticate itself.

- `mode`: `live` for protected observations or `fixture` for controlled inputs.
  Controlled completion always has `liveVerified: false`.
- `createFixture(definition, signal)`: create a new durable inventory using the
  supplied definition and return `{definition, lifecycle}`. Use
  `fixtureInventory` and `fixtureLifecycle`; do not reuse an old inventory.
  Inventory storage must outlive workers and remain available for recovery.
- `trigger(binding, signal)`: establish authorized Issue eligibility and the
  authenticated native event through the existing mechanism. Return the exact
  expected shared-Issue wake identity described in `WAKE.md`. Successful writes
  are not stage receipts. An unknown trigger effect forbids replay.
- `readWakeEvidence(binding, signal)`: independently extract the wake/route/Core
  observations consumed by `observeLiveWake`. Native observations are obtained
  separately through `observe`.
- `readDeliveryEvidence(binding, signal)`: read Core's existing protected receipts
  and referenced objects, normalize them as below. Never manufacture receipts
  from expectations, Issue labels, successful writes or a terminal invocation.
- `observe(target, signal)`: use the existing GitHub observer's complete snapshot
  format. It observes exact repository/Issue, Runs/attempts/Jobs, PR and checks.
- `assertSource(binding, signal)`: read delivered source at `mergeCommit`, assert
  exact scoped content and execute its meaningful behavior checks. Return
  `{state, requestId, repository, issue, path, content, head, mergeCommit}`.
  `state` is `satisfied`, `contradicted` or `unknown`. A successful receipt chain
  cannot substitute for this source assertion.

## Normalized delivery evidence

`admissions` lists distinct native admissions, each with `requestId`, `repository`,
`issue`, `runRepository`, `runId`, `attempt`, `jobId`. It must include the wake
admission. Later admissions may differ, but the protected reader must explicitly
associate each with this fresh request and Issue. Every admission's native Run
and exact Job must independently complete successfully.

`stages` contains exactly one current successful observation for each stage in
this order: `shape`, `validate-shape`, `publish-shape`, `deliver`, `pre-accept`,
`accept`, `post-accept`, `commit-pr`, `review-pr`, `merge`, `close`. The reader must
resolve current applicable evidence, not mix superseded attempts or Candidates.
Each observation contains the fresh binding (`requestId`, `repository`, `issue`),
its `admission`, `execution: {id, sessionId}`, and `outcome: 'success'`.
Executions and sessions must be distinct; account identity is not independence.
For technical Agent stages (`shape`, `validate-shape`, `deliver`, `accept`,
`review-pr`), include independently observed `agentExecuted: true` and
`runnerExecuted: true`. Use actual installed execution/session identities.
A reader unable to establish these facts returns unavailable evidence.

All stages have the same published `shape` identifier. `candidate` contains
`id`, `shape`, the fresh binding, `paths`, `content`, `substantive: true` and
`hooks` and `artifacts`. This bounded scenario supports empty non-tree artifact
obligations only; nonempty or unavailable obligations remain unverified. The reader must inspect actual maintained Candidate content and actual
obligations. Candidate paths must be exactly the scoped fixture source path.
Every stage from delivery onward names that `candidate` ID. These are association
identifiers from observed objects, not extra hashes or authorization conditions.

Each hook obligation is `{path, event}` in installed execution order. Only
`pre-commit`, `prepare-commit-msg` and `commit-msg` are supported. Phase stage
`hooks` lists the corresponding obligations with `executed: true` and
`outcome: 'success'`: pre-commit before Accept, the remaining events afterward.
An empty phase passes only when actual Candidate obligations for it are empty.
Unsupported mandatory effects remain unverified. This scenario installs no hooks.

`pull` contains `number`, reviewed `head`, actual `mergeCommit` and nonempty
`checkIds` for all applicable PR CI. The protected reader must resolve the actual
applicable check inventory and source; it cannot select only green checks.
Stages from `commit-pr` onward name the same `pull` number and `head`. Native
reads must confirm successful completed checks on that head, merged PR with that
head and merge commit, and the same Issue closed with `delivered`. Pending,
failed, skipped applicable or incomplete checks cannot pass.

## Results and recovery

Results contain bounded codes, no raw host records or exception text. `blocked`
identifies missing capabilities or invalid requests. `unverified` identifies
unavailable, inconsistent or incomplete observations; `failed` distinguishes a
known unsuccessful stage or native CI from a contradicted source assertion. A live
pass requires the full chain, native read-backs and source assertion together.
Synthetic tests never establish a live pass.

Teardown delegates to existing lifecycle ownership, authorization, idle and
reconciliation safeguards. No retry or automatic reconciliation follows an
unknown effect. If cleanup cannot complete, the result is unverified with
`cleanup: 'unresolved'`, preserving the original diagnostic code. The protected
caller retains the durable inventory and reconciles through the existing route;
merged history remains preserved. A timeout is not proof that work has stopped.

Local verification is `npm --ignore-scripts run verify`, using existing PR CI.
A real protected caller and complete authorized reader are external runtime
prerequisites; their absence is not a local implementation test success or a
claim that the live acceptance has occurred.

## Paired JavaScript delivery

`runDeliveryPair({repository, assignee: {id, login}}, caller, bounds)` in
`delivery-pair.mjs` (registry entry `delivery.paired.live`) prepares two owned,
independent English Issues using the configured fixture account. The adopted actor is supplied by the protected
caller. The lifecycle's `prepareDelivery` persists and confirms the body, replaces
and confirms assignment, then rereads both before adding `scope` last. Unknown
assignment effects retain the mutation intent for read-only reconciliation;
preparation never blindly retries them. The native adapter supports only the
owned Issue assignment endpoint, without changing credential discovery.

The maintained programs are `ready.mjs` and `ready-b.mjs` beneath separate UUID
ownership roots. Their exact stdout is `NIBFIN_E2E_READY\n` and
`NIBFIN_E2E_READY_B\n`. Both are triggered before waiting for either terminal
chain. `trigger` observes/correlates the scope event already produced by
preparation; it must not repeat the eligibility write. Existing Wake observation
consumes the native enrollment/forwarding producer output from #89.

The caller additionally implements `readConcurrencyEvidence(pair, signal)` using
the existing protected concurrency history producer. The argument includes fresh
pair identity, `case: independent`, ordered Issue numbers and each delivery
binding. Results use the existing `assertConcurrency` contract: complete native
admissions, Writer execution history, sufficient eligible capacity, independent
progress before the other Issue finishes, and reconciled effects. Writer identities
and admissions must match the corresponding delivery chain. Cross-Issue reuse of
executions, sessions, Candidates, Shapes, PRs, heads or native admissions cannot
pass. Native identities remain in the protected reader/recovery interface.
Incomplete history or unknown termination retains both inventories and prepared
sources; only confirmed terminal history and the existing idle lifecycle permit
cleanup. A failed cleanup prevents live success.

For paired source observations, `assertSource` must additionally return exact
`stdout`, `exitCode: 0`, and `checkout: {commit: mergeCommit, clean: true}`.
`assertMergedJavaScript(binding, checkoutMerge, signal)` is the reusable source
assertion. The protected acquisition callback supplies a disposable checkout and
`dispose`; native Git reads independently verify HEAD and clean status. The
assertion checks the scoped regular file's exact bytes, executes Node with bounded
output and compares all stdout. It disposes only after confirmed process
termination. The acquisition owner retains unknown-termination checkouts for
recovery. Unit tests execute real Node programs with explicitly synthetic Git
observations; they establish neither native merge checkout nor provider support.

PR check observations now require the complete observed check inventory to match
the declared applicable IDs; omission of an unsuccessful check cannot produce a
pass. No applicable check may be pending, skipped, stale or unsuccessful.

Project configuration scenarios use distinct target directories and repository
identities for Node/extension/first-domain and Python/override/second-domain
settings, alongside a separate dispatcher decoy. These remain synthetic staging
and plan assertions. The separate #90 admission/isolation producer and actual
host/tool/egress probes remain the protected suite's observations; a paired fixture
pass cannot certify Personal, Organization or optional MCP support.

`readIsolationEvidence(binding, signal)` reads the existing #90 protected producer
output for the selected execution Runner. Return the fresh request/Issue/repository
binding and `result`, the unchanged completed `observeIsolation` result. Its
rejection/recovery must be from the same native execution repository and Runner;
missing, unsuccessful or substituted output prevents paired success. Fixture mode
requires the producer's `synthetic` provenance; only actual `live` producer
observations may satisfy live mode. The reader retains the underlying native
observations and inventory; this scenario does not start another isolation probe.
