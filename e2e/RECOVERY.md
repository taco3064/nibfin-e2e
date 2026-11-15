# Owned lifecycle faults

`runLifecycle(request, protectedCaller, bounds)` composes existing pause admission,
native dependency delivery, and the A/B JavaScript producer from #91. Cases are
`pause-resume`, `dependency-fanout`, `duplicate-continuation`, `failed-ci`,
`cancelled-writer`, `revoked-wake`, `unknown-termination`, `unknown-write`, and
`completed-attempt`. Pause uses its repository request; dependency uses its existing
path/content request. Fault cases use the paired producer's repository/assignee
request. Ordinary worker scenarios still refuse protected execution.

The new fault composition creates both owned A/B Issues with the existing producer,
triggers them, then injects a fault on A before terminal delivery observation. B
remains independent. The final paired producer still verifies both deliveries,
source behavior, isolation, native execution and complete concurrency observations.
A recovery Wake is independently correlated by the existing terminal observer.
Cancellation requires a different resumed Job; it never changes the cancelled
Job's native outcome into success.

In addition to paired-delivery capabilities, the protected caller supplies:

- `applyFault(binding, signal)`: inject only the named fault on experiment-owned
  resources; return the binding and `state: applied`.
- `readFaultEvidence({...binding, phase}, signal)`: independently extract Core
  journal/continuation facts and native observations, never echo a mutation response
  as evidence. Phases are `before`, `recover`, and `repeat`.
- `continueFault({...binding, phase}, signal)`: use existing Core admission and
  continuation with current authorization/dependency checks. Return the resumed
  `wake` identity. This interface grants no new delivery or Wake authority.
- `restoreFault(binding, signal)`: restore only changes owned by this fault,
  performing native read-back and confirming local settlement. Return the binding,
  `state: restored`, `ownedOnly`, `nativeReadBack`, and `localSettled` as true.

Each created fixture must expose its real durable `inventory.exclusive` API.
Intent is saved before fault setup, restoration and each continuation. Unknown
results never replay a mutation or continuation. The inventory preserves the
original fault, observations, unresolved operation and prepared source root.
Independent teardown also refuses unresolved fault states after a process restart.
Only terminal native/Writer observations permit the completed inventory state.
Prepared sources and inventories remain operational recovery state, not Candidate
artifacts. Fault inventory data and protected callbacks never enter a worker.

Evidence binds request, operation, case, target Issue and actual execution
repository/Run/attempt/Job. `history` follows the shared concurrency history
contract, with one owned Issue and the same request/case. Complete histories must
retain all earlier Writers across slots and agree with overlapping final A/B
Writer history; overlap fails, and missing coverage
cannot prove exclusivity. Member identity must remain bound to the assignee.
`settledAt` records when termination and effects were confirmed; no new Writer
may start before the prior observation establishes settlement.
`execution` identifies the original Job; `resumedJob` identifies the verified
continuation. Recovery requires an operation-specific `case:reason`, independently
verified completed work, and `remainingOnly: true`.

The evidence also supplies `fault`, `demonstrated`, `status`, `termination`,
`effects`, `authority`, `dependenciesReady`, and a complete `committedEffects`
identifier inventory. Queueing/capacity do not demonstrate a fault. Unknown
termination/effects and revoked Wake remain distinct unverified outcomes without
restoration, replacement or repeated writes. Read-only native cancellation alone
cannot prove Writer termination. Recovery preserves prior effects; completed and
duplicate continuations cannot add an effect, and repeat cannot add an effect.

For failed CI, `pull` includes its number, exact head and applicable `checkIds`.
Native read-back must show an unmerged PR and an applicable completed failing check
on that head. Missing, skipped, stale and unrelated checks cannot demonstrate the
fault. After restoration, normal delivery still requires exact-head passing CI.

`e2e/test/fault-lifecycle.test.mjs` uses explicitly synthetic providers, including
unknown responses, overlap, revoked authority, stale checks and cleanup failures.
These fixtures exercise orchestration, not live cancellation or provider recovery.
Live callers, disposable native resources and host verification belong to later
authorized acceptance. Missing capabilities block before fixture creation.
