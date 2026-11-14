# Concurrency and interrupted Runner scenarios

`npm run e2e -- --group concurrency-contract` runs explicitly synthetic
assertions. `npm run verify` additionally tests adverse observations, protected
composition, native identity mismatches, unknown effects, budgets and cleanup.
These results do not certify a running Core or host.

The `concurrency` registry group deliberately reports a missing prerequisite in
ordinary workers. Protected execution calls `runConcurrency` from
`concurrency-protected.mjs` with one case (`independent`, `duplicate`,
`interrupted`, or `offline`), the controlled repository and selected member ID.
It prepares current main of Core, Action and CLI using `withDeliverySources`.
No worker receives these callbacks, source paths or raw protected observations.

The protected caller supplies these capabilities:

- `createFixture(definition, signal)` returns the existing owned fixture lifecycle
  and exact definition. Each paired Issue has a distinct durable inventory.
- `trigger(binding, signal)` performs one authorized wake, returning its exact
  `wakeId`, `issue` and `status: completed`. This acknowledges the wake operation,
  not Writer completion. Duplicate wakes get different operation IDs. Independent
  Issues are both triggered before waiting for delivery evidence. The caller
  retains native admission correlations, including coalesced or denied admissions.
- `readConcurrencyEvidence(binding, signal)` independently observes the entire
  bounded experiment. The protected environment arranges authorized interruption
  or Offline conditions; this module cannot stop hosts or change admission policy.
- `observe(target, signal)` uses the existing bounded GitHub observer for native
  Issue, Run and attempt-specific Job reads. Job status never proves host stop.

Callbacks must honor abort signals and preserve inventories on unknown effects.
A timed-out write is never retried. Incomplete observation is Unverified, including
insufficient capacity; it does not imply product failure or authorize resumption.

## Observation contract

The reader returns the exact request ID, repository, case and ordered Issue IDs.
Admissions identify Issue, Run repository, Run ID, attempt, Job ID, Runner ID and
member ID separately. Writer records add a stable execution ID, start, last
confirmed active time (`activeUntil`) and independently confirmed end (`end`, or
`null` when unknown). Times are nonnegative integer timestamps from one comparable
clock. Repeated identical execution observations are deduplicated. Conflicting
records are Unverified. Distinct intervals proven active on one Issue fail even
if the history is incomplete. Unknown termination is not an infinite active
interval and cannot alone prove overlap.

`coverage` contains start/end timestamps and `admissions: true`, `writers: true`.
These are attestations from the independently obtained protected history reader:
all wake admissions and all Writer activity for these Issues during the experiment
must be covered. Stage receipts and completed/cancelled Jobs cannot supply this
attestation. Ordinary supplied JSON cannot establish this provenance.

Independent progress requires capacity of at least two, independently eligible
work and one progress record per Issue: `issue`, `at`, `unfinishedUntil`. Each
progress point must occur during its Writer interval and before the other Issue
finishes. No shared base or merge order is compared.

Duplicate evidence maps each exact wake ID to a nonempty list of admission keys
(from `admissionKey`). Every admission must be covered. An admission without a
Writer needs independently confirmed `writerDenied: true`; absence of a receipt
is insufficient. At least one Writer and complete lifecycle coverage are required.
Each Writer must have a confirmed end or activity observed through the coverage
window end; an earlier activity sample leaves an unobserved termination gap.

Recovery identifies prior and replacement execution IDs, confirmed termination,
reconciled effects, continuing authorization and `confirmedAt`. All three facts
must cover every Writer that started before or at replacement start, except the
replacement itself. Each such Writer needs independently confirmed termination;
`confirmedAt` must be at or after every termination and before replacement start.
Naming one prior execution cannot exclude another unresolved Writer from recovery.
All recovery admissions must belong to the selected member in the request binding.
Unknown termination/effects remain Pending/Unverified despite native cancellation
or success. This is an assertion about observed behavior, never execution authority.

Offline observations require a complete route record with `offline: true`, the
selected member and retained member. Complete admissions must show no other
member. Missing route/admission evidence cannot pass; switching members fails.

## Cleanup and interpretation

The reader additionally reports top-level `effects: reconciled` only after all
experiment effects have been reconciled. Unknown activity/effects retain inventories
and prepared sources (`cleanup: unresolved`, `sourceCleanup: deferred`). Otherwise
existing lifecycle teardown still checks ownership, idle state and reconciliation.
Cleanup failure preserves the original diagnostic code and prevents live success.
Results expose bounded diagnostic codes only; receipts and provider errors stay
inside the protected process. Recovery inventories remain there, not in Candidate
artifacts. Live observations and PR-head integration CI remain separate evidence.
