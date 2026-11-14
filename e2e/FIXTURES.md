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
credential lookup, workflow dispatch or installation behavior. Supplying a token
is not fixture authorization. The runner supplies all of the following:

- A definition, the authenticated numeric actor, and a private durable recovery
  directory to `fixtureInventory(directory, definition, actor, workerRoot)`.
  Inventory and disposable worker roots must be disjoint. Preserve the inventory
  independently of worker timeout/cleanup; never place credentials there.
- `fixtureGithub({token})`, with the current restricted test actor's credential
  obtained through the protected execution context, as the lifecycle provider.
- A protected in-process `context.authorize(request)` capability. It returns
  exactly `true` only for an explicitly authorized repository, owner, actor and
  operation. Target selection cannot enlarge this grant. Operation names are
  `create-issue`, `create-branch`, `create-pull`, `close-issue`, `close-pull`,
  `delete-branch` and read-only `reconcile`.
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
