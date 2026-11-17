# Owned GitHub fixtures

These modules support controlled Issue-to-PR fixtures; they do not register a
production scenario or implement Core delivery. Routine `npm run verify` uses
synthetic providers only. It never obtains credentials or runs live fixtures.
The existing GET-only observation transport is unchanged.

`fixtureDefinition(scenario, repository?)` defaults to `taco3064/nibfin-e2e`.
Each invocation generates a distinct ownership UUID, marker, branch name and
`fixtures/generated/<owner>/` surface. Keep that definition to resume the same
execution. A new invocation is a new owner, even for the same actor and scenario.
Markers and names are discovery aids, never ownership or authorization evidence.
`generatedPath` is the single file-boundary predicate. PR setup checks the native
comparison, including rename sources, and rejects incomplete/oversized results.
Framework, tests and workflow paths are outside the generated surface.

## Protected runner integration

Only the separately authorized protected runner may import and compose the live
API. There is deliberately no live CLI, worker registration, environment switch,
host credential discovery or workflow dispatch. Supplying a credential
is not fixture authorization. The runner supplies all of the following:

- A definition, the authenticated numeric actor, and a private durable recovery
  directory to `fixtureInventory(directory, definition, actor, workerRoot)`.
  Inventory and disposable worker roots must be disjoint. Preserve the inventory
  independently of worker timeout/cleanup; never place credentials there.
- `fixtureGithub({secretProvider, user, automation?, clock?, fetcher?})` as the lifecycle provider.
  `secretProvider(reference)` is an explicitly preconfigured asynchronous capability.
  `user` contains `secretRef`, numeric `actorId`, numeric repository `ownerId` and
  exact `repository`. The repository owner ID is unrelated to the fixture UUID.
  The adapter rejects non-User actors, target/owner mismatches, unavailable access,
  and credentials without verifiable `repo` (or public `public_repo`) OAuth scope
  and native repository push access. Fine-grained credentials lacking verifiable
  scopes are conservatively unsupported here. There is no credential fallback.
  `provider(budget, definition).capabilities()` validates before provisioning and
  returns only identity, role, scope, operation and lifecycle metadata. It neither
  issues helper tokens nor grants Core authorization.
- A protected in-process `context.authorize(request)` capability. It returns
  exactly `true` only for an explicitly authorized repository, owner, actor and
  operation. Target selection cannot enlarge this grant. Operation names are
  `create-issue`, `create-branch`, `create-pull`, `close-issue`, `close-pull`,
  `delete-branch`, `edit-issue-body`, `add-issue-label`, `remove-issue-label`
  and read-only `reconcile`.
- A protected `context.idle(inventory)` capability returning exactly `true` only
  after complete, fresh evidence that no running work uses these resources.
  The runner must hold exclusion against new work throughout teardown. Missing,
  denied or incomplete usage observations must return false/undefined or throw.
  This API never cancels running work to obtain that condition.

These callbacks and the provider are trusted process capabilities, not values
that may be populated from an Issue, fixture text, Agent request, CLI flag or
ordinary PR CI. Workers must never receive this API, its token or the callbacks.
This library does not certify or create that host isolation boundary.

Construct `fixtureLifecycle({inventory, provider, context, bounds?})`. Operations:

| Method | Native effect | Preconditions |
| --- | --- | --- |
| `setup('issue')` | Create the controlled Issue | Authorized exact target/actor |
| `setup('branch', {sha})` | Create the uniquely owned ref | Absent ref, existing base commit |
| `setup('pull', {base})` | Create a PR from the owned branch | Owned head, bounded generated diff |
| `mutateIssue(operation, input, target?)` | Edit body or add/remove one label | Exact owned open Issue, operation authorization |
| `reconcile()` | Read and classify unresolved effects | Exact native identity or protected receipt |
| `teardown()` | Close owned PR/Issue; delete unchanged ref | Authorized, fresh native state, idle work |

A branch starts at the supplied current source commit. The existing source owner
continues to acquire current main of Core, Action and CLI; no version catalog is
introduced. Core delivery, not fixture setup, performs generated development.
A PR requires a substantive generated diff; this library neither commits files
nor grants an Agent permission to change maintained sources or bypass Core gates.
A supplied base commit is input to native ref creation, not a version prerequisite
for starting/resuming delivery.

Every effect is covered by a resource record with its owner/scenario/repository
and actor in the inventory header, kind, exact setup payload, unique operation
intent, native identity, allowed cleanup operation, state and disposition. Intent
is flushed before each write. Native creation identities are flushed before the
confirmation read. Writes are never automatically retried. No API discovers and
adopts resources just because a marker, title, scenario or actor matches.

## Interruption, results and cleanup

`passing` means only that the requested local fixture operation has no unresolved
state. It is not a live E2E, Core Accept, CI, merge or release result. `unverified`
preserves the recovery path and resource records, without provider exception or
credential text. Setup, teardown and reconciliation have finite positive request,
operation and elapsed-time limits; network/body reads and capability calls are
also timed. Requests include capability/provider calls as well as HTTP requests.
A provider ignoring abort may still complete remotely; timeout is never proof
that a write did not happen.

A persisted native identity can be read after restart. If a creation response was
lost before identity persistence, only a protected native execution receipt can
resolve it: optional `context.receipt(record, definition)` returns
`{operation: record.operation, native: <native creation response>}`. The runner
must establish the response's binding to this exact operation independently of
markers (for example from its protected execution evidence). An ambiguous search
match or a missing receipt leaves the intent unresolved. No blind re-creation,
rollback, automatic abandonment or deletion is attempted. The inventory alone
cannot reconstruct an unobserved GitHub response.

Unknown creation or cleanup effects block all further mutation. Reconciliation
of cleanup requires the terminal effect (closed resource or absent ref); an open
resource does not prove an earlier timed-out write has stopped. Merged PRs and
associated branches are retained as `merged-history`; commits are never rewritten.
Changed unmerged branches conservatively require further ownership evidence and
remain visible for protected recovery instead of being deleted. The fixture API
has no operation to override that refusal. Unrelated resources, credentials and
running work are never cleanup targets.

The inventory uses an exclusive owner lock and atomic flushed replacement. An
interrupted process can leave a `.lock` file. Only the protected runner may remove
that lock after independently confirming the previous process and requests have
settled; the library never guesses that a lock is stale. Retain unresolved ledgers
and minimum recovery evidence. Once all resources are cleaned or explicitly
retained and recovery is no longer needed, the runner owns retiring the ledger.
This library never erases recovery records as part of worker cleanup.

Issue mutation input is a body string (up to 60,000 characters) or one label
name (up to 50 characters). Body editing preserves the ownership marker; label
transitions preserve unrelated labels. Optional `target` is the expected
`{repository, number}` and must match the durable owned identity before writing.
An independent native read confirms the requested effect. A persisted mutation
intent blocks setup, further mutations and teardown until `reconcile()` confirms
the exact effect and protected `idle` confirms that prior requests and users have
settled. A different body or incomplete label observation remains unresolved;
the library cannot abandon or retry an unknown write. Retain that recovery ledger.

See [WAKE.md](WAKE.md) for protected live composition and credential-free scenarios.

## Installation credential lifecycle

`fixtureCredentials({secretProvider, user, automation?, clock?})` keeps secrets in
private session state. The protected composition supplies the same User configuration
as above. Optional `automation` contains `secretRef` for preconfigured App JWT
bootstrap, numeric `appId`, numeric `installationId` and explicit `operations`.
Only `create-branch` and `delete-branch` are supported for automation. User-authored
Issues, PRs and their mutations remain on the User route in `fixtureGithub`.
The library does not mint JWTs, configure secrets or install Apps.

Compose a credential session with `credentials(request, definition)` where the
trusted GitHub provider implements
`request(token, method, absoluteUrl, body?, missing?)`. It must bound requests and
response consumption, reject redirects and non-success statuses, and return
`{status, data, scopes?, link?}`. `scopes` is the native `x-oauth-scopes` header.
For independent revocation observation only, `missing === 'revocation'` allows a
native 401 response through. Ordinary failures must throw. Providers and returned
secrets stay inside the trusted composition, outside workers and recovery records.

The native adapter exposes the same session methods as `api.automationBranch`
and `api.revokeAutomation`, sharing its request budget and bounded secret-provider
calls. Call `api.revokeAutomation()` before releasing that native session.

Before an independently authorized automation operation, call
`session.automationBranch(operation, sha?)`. The operation uses only the definition's
branch in the configured repository. This credential capability is not an ownership
or authorization grant: the protected runner must enforce authorization, absence,
base/ownership, idle and unknown-effect checks before calling it. Existing fixture
lifecycle operations continue using User authentication and all their existing checks.

Issuance first validates the adopted User, then the installation's App, owner,
suspension and contents grant. Requests select only the target repository ID and
`contents: write`; returned permissions and native installation repository access
must match. The injected millisecond clock checks returned expiration. Expired
helpers require newly issued, validated replacements with identical scope.
Failed issuance/renewal blocks further automation; unknown issuance is retained as
unverified cleanup. A mutating request is never automatically retried.

`session.revoke()` disables automation and revokes every helper issued in that
session, including replaced or rejected helpers. Bootstrap and User credentials
are never revoked. Cleanup is successful only after a successful deletion request
and separate native readback returning 401. Continued access, a failed request,
unknown issuance or unavailable readback produces `unverified`. Repeat cleanup can
observe outstanding known tokens; it cannot resolve a lost issuance response.
Keep the trusted session alive until cleanup completes. If its private state is
lost, token effects remain unverified; no token is persisted for recovery.

Fake-provider/clock tests are local library evidence. Supported real User bootstrap,
App permissions and independent revocation readback still require the dedicated
live test environment. They are not certified by local verification.

Scenario source requirements live in the validated registry. `wake-contract` and
`concurrency-contract` use no producer inputs through the standard CLI. Core
component fixtures request only Core checkout identity. Mixed selections retain
independent fixture results when a required producer fails; affected entries report
`SOURCE_PREPARATION_ERROR`. These controlled results grant no protected capability
and do not establish live provider or host verification.
