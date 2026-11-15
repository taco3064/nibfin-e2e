# Issue-wake and Action contracts

Issue #29 maintains two separate legs: `shared-issue` and `action`. The installed
Issue caller invokes Core's reusable Issue workflow and shared Runner directly.
It does not invoke the Action. Native Action CI's conditional `not-a-stage` step
can establish only its executed denial contract, never authorized delivery.

`npm --ignore-scripts run verify` runs the controlled positive/negative contracts
and recovery tests without credentials. The registry's `wake.*.fixture` scenarios
use the existing worker execution/assertion contract. Their titles and IDs mark
fixture coverage. Production source acquisition and compatibility checks remain
owned by the existing source library. No live scenario is registered with workers.

## Protected composition

Only an independently authorized protected process may compose
`mutateAndObserveIssue({lifecycle, operation, input, expected, observe,
readEvidence, bounds})`. It checks the expected repository/Issue against the owned
inventory before mutation. A confirmed write is followed by separate observations;
it does not prove GitHub emitted an event. The caller obtains the originating Run
identity from native evidence, never from a guessed latest Run or write response.

Use `observeLiveWake({leg, expected, observe, readEvidence, bounds})` for an
already authorized existing invocation, including the Action CI denial step.
This function never dispatches, installs, selects an assignee or grants authority.
`observe` is the existing bounded `githubObserver` function. `readEvidence(signal)`
is a protected extractor of actual Core, forwarding and Action observations.
Honor abort and finite budgets; do not expose credentials or raw logs to workers.
Absent authorization means do not invoke the operation. Absent observation means
`unverified`, not expected denial. Live invocation remains a separate protected
runner responsibility, unavailable in routine local verification.

## Normalized observation input

`correlateWake(leg, expected, evidence, mode)` is a pure bounded assertion.
Explicitly pass the fourth argument `fixture` for
synthetic evidence; the mode is provenance supplied by the protected caller,
not an authenticity check. Public output contains leg, mode, state, a maintained
diagnostic code and, for passing shared execution, the allowlisted observed OIDC
identity binding. No provider objects, tokens or raw errors are emitted.

`expected` binds the Issue's `repository`, Issue number (`issue`), the execution
`runRepository`, Run ID (`runId`), attempt,
Job ID (`jobId`), invocation identity, requested stage, expected Core status and
code. Shared-route expectations additionally bind `originRunId`, `originAttempt`,
`reusableWorkflow`, `sharedWorkflow` (native Run path), `runnerId` and `runnerLabel`.
Action expectations additionally bind the observed `actionRef`.
The Issue/origin repository and execution repository are separate: a forwarded
shared Job can run in Core while its target Issue remains in the consumer repo.
Workflow and invocation identities must come from the authorized native execution,
not a fixture or a replacement version catalog.

Native `issue`, `run`, `jobs` and shared-route `origin` entries use the existing
observer's `{target, complete, data}` envelopes. Incomplete envelopes never pass.
`jobs` must be the attempt-specific complete collection. The native Run and Job
must be terminal; successful completion also requires native success conclusions.

The protected extractor supplies these additional bounded records, retaining
their native provenance outside published reports:

- `route`: repository, issue, originating Run/attempt, reusable workflow and
  observed `decision: forwarded`.
- `wake`: the same Issue/origin binding, selected execution binding (Run, attempt,
  Job, invocation, stage), shared workflow and Runner label actually forwarded.
- `core`: exactly one observed result with the execution binding, status, code
  and `receiptHash`. Completion requires a receipt; denial requires it empty.
- `action`: execution binding, actual `actionRef`, `executed: true`, native
  `stepNumber`/`stepName`, and outputs `status`, `code`, `receipt-hash`. The native
  step must have executed and agree with Core; skipped integration is unverified.

These are normalized observation records, not a new Core wire protocol or policy.
The extractor must establish invocation-to-step and workflow-to-wake associations
from actual execution evidence. Copying expectations into these records, accepting
dispatch alone, or trusting records from Issue text is not live verification.

`correlateNoAssignee(expected, evidence, mode)` separately confirms the bounded
negative route observation: an exact native Issue/origin association, observed
`decision: no-eligible-assignee`, `forwarded: false`, no wake and no Core admissions.
It never computes eligibility. Pending admission never passes. Duplicate Job IDs,
multiple copies of a Core result and arrays of wake records are rejected. Each
separate admission needs its own native execution and Core evidence; callers must
not sum repeated observations into multiple admissions.

The local tests use synthetic providers even when exercising protected composition.
No test result here claims a live GitHub event, Action invocation or host support.

## Peer enrollment and shared identity (#89)

`protectedPeerEnrollment` in `peer-protected.mjs` is an operator-only library.
It receives prepared `sources`, the existing exclusive repository `inventory`,
and an independently authorized `context`. Ordinary scenarios receive neither
this context nor privileged callbacks. The context fixes `origin` (`operator`
or `synthetic`) and `binding`: owner, hostId, memberId, B's repository/name and
repositoryId, and A's runRepository/name and runRepositoryId. The installation
record in that inventory must already independently confirm A's installation,
prepared sources and two distinct native Runner identities.

The context implements `authorize`, `observe`, `adopt`, and `reconcile`.
`adopt(binding, {sources, intent, signal})` invokes the existing Core peer adoption
capability through the authorized operator adapter. It cannot select a command,
credential or host. `reconcile(binding, intent, {signal})` must confirm both
`terminated: true` and `effects: reconciled`. A lost response or timeout retains
the adoption intent in `installation.peers` in the same recovery inventory.
Read retries cannot clear that intent or replay adoption. Repeated successful
enrollment reads current state and preserves the original pool identities.

`observe(binding, {signal})` supplies independent readback:

- `binding`, prepared `sources`, and `authenticatedMemberId`;
- `registrations`: B's repository/name, repositoryId, `complete: true`, and a
  native `runners: []` collection (incomplete data cannot establish absence);
- `executionRegistrationsComplete: true` and `executionRunners`: A's two original
  native id, name, memberId and repositoryId associations;
- `adopted` from the protected adoption readback;
- `callers.issue`, `callers.action`, and `callers.execution`, each with repository,
  repositoryId, workflowId, path, sourceCommit, branch, ref, blob, content,
  `complete: true` and `active: true`.

Caller contents must exactly match recipes imported from prepared Core using
its prepared Core/Action source identities and enrolled member. The execution
workflow must match the prepared Core workflow. Full contents and raw provider
objects are discarded. The observation's sourceCommit identifies the currently
adopted invocation source; no additional version catalog or historical branch
head is required. Unrelated branch advancement alone does not reject enrollment.

`enrollAndObserveSharedIssue({enrollment, ...observationOptions})` composes a single
enrollment with Wake observation, injecting its result into the evidence. It
never dispatches and never retries enrollment. `observeLiveWake` also accepts
`maxAttempts` (1 by default, at most 10); one shared request/time budget covers
all read attempts. `observe(target, undefined, {signal})` forwards cancellation
to the bounded GitHub observer and provider. Mutation remains outside read retries.

Shared expectations and observed Core/Wake records additionally bind numeric
repositoryId/runRepositoryId, Issue node identity `issueId`, actorId, checkRunId,
workflowId, workflowRef, sourceCommit, ref, workflowBlob, originActorId,
originWorkflowId, originSourceCommit and originWorkflowRef. The route retains
B's identity and originating actor/workflow/source. The execution actor and
origin actor are independently checked; neither is inferred from the member.
The complete native Job must carry the selected pool Runner's id/name and a
check_run_url for the expected checkRunId. Native repository IDs, actors,
workflow IDs, source commits and branches must agree with the enrolled callers.

`forwarding` retains the observed originating repository/Issue/Run/attempt and
actor association, dispatched execution repository/Run/attempt/actor and
workflow/source identity, with `confirmed: true`. It must come from the explicit
forwarded Run association, never a latest Run lookup or a dispatch status alone.
`oidc` retains the protected caller's verified Core identity result: repositoryId
(of A), runId, attempt, actorId, checkRunId, sourceCommit, expiresAt, identityHash,
plus its native jobId/runnerId association and `verified: true`. Only the eight
Core identity fields are retained in a passing public result. Raw tokens,
request credentials, provider errors and additional OIDC fields never escape.

`permission: unavailable` or the protected adapter's typed
`WAKE_PERMISSION_DENIED` produces `WAKE_PERMISSION_UNAVAILABLE`, always unverified.
It is distinct from a fully correlated Core denial. Missing Runs, dispatch-only
responses, skipped execution and pending outcomes never pass. Synthetic enrollment
cannot establish live correlation. Action and no-assignee contracts remain separate.
