# CLI onboarding contract

`npm run e2e -- --group cli-onboarding` uses the existing source adapter to
acquire current main, build producers and check their compatibility. It does
not override consumer pins or certify incompatible producer sets. GitHub
credentials and external writes are unnecessary. Source acquisition still
requires public network reads and the native producer toolchains.

The registered contract copies the prepared CLI into disposable storage and
adds these Go test drivers beside its maintained synthetic API transports.
It runs `go test -json -count=1 -parallel=1 -timeout=90s ./internal/cli` with
the fixed scenario selector. Helpers such as `installFixture` and `upgradeFixture` belong to
that acquired CLI, including their archive consistency checks. If their seams
change, compilation/assertion failures remain failures, never skips. No
upstream command implementation or compatibility declaration is rewritten.

On Linux the same subprocess must pass the producer's managed-resume case.
That case runs the actual orchestration against in-process GitHub fixtures,
temporary install intent, synthetic credentials and controlled host operations.
It covers interrupted PR waits, partial service startup and a peer repository
reusing the original Runner IDs. A missing or skipped case fails the contract.

The drivers execute `App.Run` for installation preview, source rejection and
upgrade preview/apply. Installation proposal tests decode the actual preview
and call the same maintained `applyInit` implementation used by `App.Run`.
This isolates proposal behavior from the separately verified Core cache step:
no fake verifier claims a successful cache installation. The full init command
is also checked to reject a missing genuine pinned artifact before mutations.
Synthetic recipes and archives are fixtures, not evidence that the prepared
producer outputs, protected host, or any live installation were verified.

Both Personal and Organization owners exercise preview, PR target/head and
workflow/label read-back, repeats, unchanged installations, permission changes,
workflow-write denial, conflicts, malformed responses, unavailable read-back
and lost writes. Upgrades also exercise source rejection, layout recognition,
proposal reconciliation and preservation of unrelated files. A returned open
PR remains pending review/merge; neither suite updates main nor merges itself.

The parent runner owns the fixed Go subprocess operation. Workers cannot send
arbitrary executables, arguments or environment variables to it. Timeout aborts
the process group and awaits pipe closure before worker storage is removed.
Normal execution also removes the private checkout, home, configuration and
Go caches after termination. Prepared sources retain their existing owner and
lifetime. The local verifier covers the parent/worker timeout boundary with a
real descendant process, as well as all created Go/JavaScript source size limits.

## Protected live handoff

`handoff.d.ts` describes the bounded data interface; `handoff.mjs` validates
exact fields and compares results. The separately authorized operator owns
the receiver, credentials, target, invocation, provider reads and external
cleanup. This package supplies neither credentials nor that privileged runtime.
The `operator` provenance value is a claim about the supplied observations,
not proof of authorization. No callback, command, fixture capability or
credential field is accepted. The allowed file surface is the CLI's managed
workflow files and producer pins, independent of the Issue/PR fixture API.

Each request binds a scenario, intent, numeric target identity, owner type,
default branch/base commit and actual Core/Action/CLI repository/commit
identities. These are observations of the invocation, not an independent
version catalog or a fixed-version prerequisite. Expectations contain proposed
managed file contents, lifecycle labels and (for proposals) a branch name.
The operator normalizes actual emitted CLI plan/result documents into `cli`
and supplies independently read provider state in `provider`. `cli.files` and
`cli.labels` represent the emitted plan. For an unchanged plan they are empty;
its successful no-change status and absence of mutations are checked. For a
proposal, provider files/labels must match the proposed contents/labels and the
observed open PR must match the CLI URL, base, head and a new head commit.
Provider read-back must also establish an unchanged default branch and no merge.
For a preview, the operator must observe zero provider mutations and local
installation effects; existing repository content need not equal the proposal.

`compareHandoff(request, observation)` returns a bounded comparison result.
Unavailable provider reads may use null for unknown counts, branch commit and
merge state; the receiver must never invent confirming values. Missing live
observations, unavailable reads and recognized unresolved effects
remain `unverified`. CLI/API errors and contradictory observations are
`failing`. Synthetic matches always remain `unverified` with
`SYNTHETIC_CONTRACT_MATCHED`. Matching operator observations can pass only the
bound scenario comparison; `protectedExecution` remains `unverified` in every
result. No comparison authorizes execution or certifies release readiness.
Live recovery evidence stays with the operator; no credentials or raw provider
transcripts enter ordinary workers. Missing authorized Personal/Organization
execution is unverified, independently of a passing contract run.

The existing local verifier runs handoff and harness assertions without network
access. Native contract execution additionally runs the acquired current CLI's
actual Go logic. Full producer acquisition/compatibility remains a separate
prerequisite in the existing adapter; a direct driver check cannot certify it.

## Bounded shared installation

`protectedSharedInstallation` (also exported by `runner-live.mjs`) composes only
in the protected operator, alongside the existing Runner lifecycle. Its `install()`
accepts no worker input. `installation.d.ts` describes the capability and result
boundary; `runner-observations.mjs` separately compares the normalized results.
It uses the same `fixtureInventory` object as `repositoryLifecycle`, preserving
both seeded repository records and an `installation` recovery record in that
exclusive, flushed inventory. No second resource registry or pin catalog exists.

The protected context binds the inventory owner, authenticated member, selected
native repository ID and disposable Linux host allocation. Its credential
capability is the upstream validated User capability for that selected repository;
secrets stay inside the capability and executor. Source preparation still owns the
actual producer outputs. Installation reruns `verifyCompatibility` against those
outputs without rewriting declarations. Native observations must independently
report matching Core, Action and CLI identities, repository/member/host bindings,
complete registration readback, local registration identities and native endpoint.

The operator supplies fresh `observe` reads of the installation PR number, head
commit and repository ID, applicable check state, completed external review/merge
and installed content match. An unavailable PR or pending prerequisite returns
incomplete. This driver does not publish or merge an installation PR. Publication,
review and merge use the separately authorized operations route. The operator must
establish `contentMatches` from the managed content for the prepared producers,
not from a PR label or successful command. It must bind that read to the selected
repository and invoke the command under authorization that excludes unintended
publication if the target changes. The CLI's own planning/readback and native
permission checks remain authoritative; the E2E driver does not replace them.

Once those prerequisites and host adoption are confirmed, the driver invokes the
prepared executable with `init --repo OWNER/REPO --apply --start-shared-services`.
The protected executor owns credentials, target host, noninteractive stdin,
deadlines, cancellation, output bounds and process-group termination. It returns
`terminated: true` only after confirming termination. All capability calls have a
finite request/total budget, including authorization, provider reads and recovery.
A timeout leaves a durable intent; it does not prove termination or no effects.
Never retire a host while that intent is unresolved. The operator must also bound
its underlying transport and storage operations and preserve exclusive ownership
while an outstanding request may still execute.

`observe` returns complete selected-host registration inventory, including exactly
two distinct IDs/names for success, endpoint, member/repository IDs, local ID/name,
shared registration flag and independently observed GitHub online state. It also
reports actual service user/state separately from command stdout. Missing values
normalize to null. Complete readback with more than two registrations, identity
changes, wrong endpoints, changed sources and failed checks cannot become success.
A second success preserves the original pair. Confirmed partial registration is
journaled before continuing, and a pending command must first pass protected
`reconcile` with both `terminated: true` and `effects: 'reconciled'`. This means
native inspection has accounted for every effect of the recorded intent, including
partial registrations and installation PR effects; it is not a timeout receipt.
Uncertain reconciliation never repeats apply. No installation path deletes resources.

Adapters translate native permission failures into an error with
`code: 'INSTALLATION_PERMISSION_DENIED'` and a bounded `operation` from
`read-installation-pr`, `read-runner-registrations`, `register-shared-runners` or
`start-shared-services`. Returned refusals identify the expected member and role;
raw errors and subprocess diagnostics are discarded. Other exceptions remain
incomplete, since they cannot establish a permission denial or lack of effects.

`node --test e2e/test/installation.test.mjs` exercises synthetic process/provider
capabilities and real flushed inventory recovery. Synthetic successes stay marked
synthetic and compare as unverified. Even matching operator results leave protected
execution unverified. Dedicated-host execution, protected workflow maintenance,
credential/service configuration, real-host certification and teardown remain on
their separately authorized routes; ordinary PR verification never operates a host.

### Current-attempt protected invocation (#109)

Trusted consumers import `protectedCliInvocation` from `e2e/cli-invocation.mjs`.
Supply the existing prepared sources, exclusive upstream inventory, installation
context, finite bounds and a protected `run: { runId, attempt }`. No credentials,
host selection or adapters are read from scenario input. The registered worker
scenario `cli.invocation` always reports its protected prerequisite.

Each call generates a fresh invocation ID and invokes the prepared `init --apply
--start-shared-services`, including when installation was already complete. The
existing authorization, compatibility, installation PR and host prerequisites
remain mandatory. Installation publication/review/merge are external operations.
The existing pending intent now includes invocation identity before execution.
Unknown termination or effects retain that intent; recovery must reconcile before
another apply. Neither timeout nor command output proves safe recovery.

The context's independent `observe` reads receive the invocation identity and
return the normal installation readback plus `invocation.github` and
`invocation.host`. Each channel supplies the exact `runId`, `attempt`, `id` and
prepared executable `entry`, `fresh: true`, `terminated: true`, and
`effects: 'reconciled'`. Channel `origin` is `native` for actual provider/host reads
or `synthetic` for controlled transport tests. Adapters must independently
associate those reads with the process and its effects; echoing request fields,
loading saved receipts or reading stdout is not native observation. Both channels
must agree with the protected context's evidence level. An operator label alone
cannot upgrade synthetic channels. All installation identities and source pins
are independently checked on the same readback, including after reconciliation.

The typed result adds `invocation` with `invoked`, `terminated`, `confirmed`,
validated channel `observations` (or null), and evidence level
`native`, `controlled` or `unverified`. Controlled success is regression evidence
only. Even native invocation confirmation leaves `protectedExecution` unverified:
it grants no release authority and does not certify full delivery or readiness.
Absent capabilities return a sanitized prerequisite result. Errors and subprocess
diagnostics are never included. Consumers must use this protected producer's
current result rather than interpreting a serialized result as fresh execution.
Actual disposable-host execution and protected adapter provisioning remain on the
separately authorized acceptance/operations route; no live run is claimed here.

## Upgrade and source continuity (#93)

Issue #93 extends the synthetic upgrade sequence through provider merge readback.
The proposal and open PR retain the old installed pins; only reading the simulated
merged revision establishes repository adoption. Host adoption remains separate.
The CLI's maintained planner and compatibility checks supply both source sets;
this driver never rewrites consumer pins to make source preparation compatible.

The same native contract runs `continuity.mjs` against the prepared Core's
`readSharedCaller`, and `delivery-continuity.mjs` against its `decideStage`.
Producer-owned synthetic stage fixtures are required from the prepared source;
missing interfaces or fixtures are unavailable evidence, never skipped success.
These assertions cover unrelated advancement, disablement, removal, replacement,
restoration, forged workflow identity, Candidate equivalence and native merge CI.
They remain synthetic even when executed by real Go and Node processes.

Protected Wake extractors retain the original admission enrollment and its source
set for each exact run/attempt/job. They supply `continuity` from
`readWakeContinuity` using that job's prepared sources, independently resolved
workflow node IDs and a bounded native GraphQL reader. Its current-main reads
check revocation; they never select executable code or replace the enrollment.
Missing continuity is unverified. New jobs require their own adopted enrollment.

Protected delivery extractors can supply `applicability` from
`readDeliveryApplicability` using the independently resolved Core close context
and the normalized evidence. This consumes Core's own equivalence, independent
Acceptance, review and CI rules. No list of equivalent Candidates supplied to the
E2E validator establishes reuse. A denied producer result remains unverified.
The observation binds the current Candidate, PR, checks and each original stage
execution/admission. Native checks are read at the producer-approved tested SHA,
including a correctly associated merge preview. Raw contexts, credentials and
producer diagnostics remain inside the protected reader.

The later disposable acceptance executor still supplies real compatible source
preparation, host adoption, protected revocation and live A/B observations. Local
synthetic assertions do not certify those external operations or release readiness.
