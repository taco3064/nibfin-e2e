# CLI onboarding contract

`npm run e2e -- --group cli-onboarding` uses the existing source adapter to
acquire current main, build producers and check their compatibility. It does
not override consumer pins or certify incompatible producer sets. GitHub
credentials and external writes are unnecessary. Source acquisition still
requires public network reads and the native producer toolchains.

The registered contract copies the prepared CLI into disposable storage and
adds these Go test drivers beside its maintained synthetic API transports.
It runs `go test -json -count=1 -parallel=1 -timeout=90s ./internal/cli -run
'^TestE2E'`. Helpers such as `installFixture` and `upgradeFixture` belong to
that acquired CLI, including their archive consistency checks. If their seams
change, compilation/assertion failures remain failures, never skips. No
upstream command implementation or compatibility declaration is rewritten.

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
