# Resumable suite

`runSuite(coordinator, request)` in `runner.mjs` is the protected framework
entrypoint. Existing scenario/group runs and their report format are unchanged.
Requests contain only a non-secret `runId`, a `phase` (`provision`, `install`,
`delivery`, `failure`, `cleanup`, or `complete`), and a boolean `resume`.
Requests cannot select modules, commands, credentials, or capabilities.

`createSuite` in `suite-drivers.mjs` composes repository provisioning, protected
shared installation, and protected run teardown. Protected composition supplies
already bound delivery/failure adapters with `execute` and `reconcile`, using
predecessor producers and their native recovery observations. The lower-level
`protectedSuite` supports controlled drivers without external resources.
`suiteProducers` in `suite-producers.mjs` supplies the maintained paired-delivery
and fault-lifecycle adapters without reacquiring or disposing suite-owned sources.
Its protected `open` binds dispatch to the suite intent and checkpoints native
execution; recovery invokes the supplied reconciler, never a new producer.
Missing capabilities remain explicitly unresolved.

Keep the prepared source owner outside worker roots. `prepareSources` now returns
an operational `ownershipId`; retain it, the original immutable sources, and their
checkouts across interruptions. Recovery must restore this original owner, not
call current-main preparation again. `verifyOwnership` independently confirms
availability and ownership; `createSuite` also reruns maintained consumer
compatibility checks. These identifiers correlate resources, not authorization.

The suite stores progress in `state.suite` of the existing fixture inventory.
The original inventory remains exclusively held while scoped driver access lends
its state/save capability without acquiring the same lock twice. Concurrent
attempts fail acquisition. A timeout retains the lock while a call may still run;
protected recovery must prove termination before retiring it. Never delete a lock
based on age. Default fixture budgets bound calls, operations, and elapsed time.
The executor retains operational recovery files; Candidate delivery creates none.

Each phase intent is flushed before driver invocation. Delivery adapters must
persist their dispatch intent using their existing driver recovery records and
call `checkpoint` with the native execution identity before subsequent actions.
On restart, the suite calls only `reconcile` for phases with an intent, including
completed phases. Reconciliation must independently observe execution/effects;
it cannot invoke a fresh delivery or failure producer to replace unknown work.
Only bounded identity/resource fields from driver observations enter reports.
Unobserved, missing-input, failed, and unresolved phases remain distinct.

Independent phases do not execute missing upstream phases. Previously completed
upstream phases are reconciled before reuse. Complete execution stops at the
first non-passing phase and enters protected teardown when no adapter is still
running. Teardown retains its native exclusion, settlement, ownership, credential
revocation, and baseline requirements. Pending execution blocks racing cleanup;
reports name unresolved intents and known resources. Source ownership must remain
available while effects or cleanup are unresolved.

Protected release preflight requires `capabilities.suite.open({ invocation })`
to return `{ prepared, result }` for the original suite source owner. This is a
protected capability, never invocation input, and must freshly observe the suite
result. The gate rejects missing/controlled summaries, mismatched invocation,
source identity or source ownership, pending resources, and incomplete phases or
cleanup. It then runs the existing independently bound native producer coverage;
the suite summary cannot substitute for those observations. Contract-only gate
composition remains explicitly non-publication evidence.

Controlled tests demonstrate orchestration and recovery, not live GitHub, host,
WSL, native E2E, or release readiness. No workflows or operational permissions
are changed by this framework extension.

## Durable simulated CLI

The suite command family uses the same coordinator and maintained drivers as the
in-process API. It accepts exactly one `--suite`, `--run-id ID` and
`--state-dir PATH`, with optional `--phase PHASE` and `--resume`. Omitted phase
and `--phase complete` both run the entire lifecycle. Mixing suite options with
`--group`, repeated options, missing values and unknown phases fails before work.
Existing no-argument and group requests retain their scenario result format.

Separate processes can advance one session:

```sh
node e2e/cli.mjs --suite --run-id demo --state-dir ./state --phase provision
node e2e/cli.mjs --suite --run-id demo --state-dir ./state --phase install --resume
node e2e/cli.mjs --suite --run-id demo --state-dir ./state --phase delivery --resume
node e2e/cli.mjs --suite --run-id demo --state-dir ./state --phase failure --resume
node e2e/cli.mjs --suite --run-id demo --state-dir ./state --phase cleanup --resume
```

A selected phase reconciles recorded prerequisites; it never creates missing
prerequisites. Resume requires the original run, sources, ownership and inventory.
A new invocation without `--resume` cannot replace an existing session. Missing,
corrupt or conflicting inputs yield a non-passing JSON result without resetting it.
Concurrent acquisition and interrupted leases remain explicitly unresolved.

Suite stdout is one JSON document, with `kind: "suite"`, `schemaVersion: 1`,
`provenance: "controlled"`, run/source identities, requested mode and phase,
phase states/codes, pending resources/intents and cleanup disposition.
Delivery and failure phases include individual `fixtures` with stable program
IDs, scenario IDs, states and codes. Fixture outcomes require their own maintained
observations. One failed independent fixture does not suppress another fixture's
terminal observation. Pair association and settlement remain phase requirements;
two individual passes alone do not establish a paired pass. No raw provider graph,
requirements, diagnostics, commands or credential objects appear in the report.

Exit status is 0 when the requested phase passes, even if later phases remain
unobserved. Complete mode requires every phase and safe cleanup to pass.
Invalid, missing-input, failed and unresolved requests exit 1. npm callers should
use `npm run --silent e2e -- ...` when consuming stdout as JSON.
