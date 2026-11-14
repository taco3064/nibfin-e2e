# Pause and failure recovery scenarios

Select group `pause` through the existing CLI. `pause.recovery.fixture` runs
`pause-core-contract.mjs` under bounded source-process supervision against the
prepared compatible current-main Core checkout. It imports actual Core policy
and Core's controlled test helpers. It does not copy pause qualification,
admission, journal repair or continuation policy into E2E. The synthetic readers,
receipts, clocks and owned child are controlled fixtures, never live evidence.
The script also runs directly with `E2E_CORE_ROOT` pointing to a disposable Core
source checkout. The standard verify command checks its syntax and size; running
its behavioral cases requires the producer checkout.

The controlled cases cover every stage's pause admission, lawful resume with
ordinary gates, incomplete/unqualified history, lost repair responses, bounded
transient reads, completed-stage reuse, unknown writes and uncertain termination.
The child fixture is disposable, receives no credentials and is terminated and
awaited in a finally block. Its exit never proves a different Writer stopped.
Successful fixture assertions retain `liveVerified: false`.

`pause.live` blocks in ordinary workers because they receive no protected caller.
`runPause(repository, caller, bounds)` is the protected composition entry point
for native owned-Issue label/event and Core admission observations. It uses the
existing fixture mutation lifecycle for adding and removing the single `pause`
label. Mutation success, exact native snapshots and Core admission evidence are
separate requirements. Event history must extend the previous complete history;
stale or partial observations cannot establish success.

The protected caller supplies `mode`, `createFixture`, `observe`, `admitPause`
and `readPauseEvidence`. Callbacks receive an abort signal and must honor bounded
execution. `createFixture` returns the supplied fresh definition, durable inventory
and existing lifecycle. `observe` uses the existing bounded GitHub observer.
`admitPause` invokes actual Core admission without executing a subsequent stage;
it receives a fresh binding with request ID, repository, native Issue ID/number,
and phase (`paused` or `resumed`). In live mode it also receives sources prepared
through the existing compatibility mechanism. No worker input authenticates
these capabilities or permits installation or host changes.

`readPauseEvidence` independently extracts `{admission, observation, pause,
stageAdmitted, createdReceipts}` from protected Core execution. Admission binds
the request and exact native run repository, run ID, attempt, Job ID, invocation,
decision, code and `executed: true`. Observation contains the exact native Issue
and complete event array Core used. Native Run/Job read-back is required. The
paused decision must deny with `ISSUE_PAUSED`; the resumed decision may allow
ordinary admission. Both must report no stage admitted and no created receipts.
This verifies removal of a restriction, never completed delivery. Full protected
delivery remains the existing delivery scenario's responsibility.

Before admission, intent and the bound snapshot are saved in the owned recovery
inventory; live source roots are saved there too. An exception or ambiguous
response leaves intent unresolved and blocks mutations and teardown. Resume
cannot erase it. `reconcilePauseExecution` only reads evidence for that exact
invocation and rechecks native observations. It never invokes admission or retries
a write. Unresolved cleanup retains the inventory and source checkout through
the existing source owner. The protected owner may remove them only after bound
reconciliation and confirmed idle teardown. Fixture tests delete their temporary
inventories after all owned activity ends; they cannot certify remote cleanup.

Unavailable protected capabilities and incompatible producer declarations remain
blocked/unverified. Local source fixtures do not certify installed execution,
GitHub qualification receipts, remote Writer termination or live platform support.
