# Release gate integration

`createReleaseGate(capabilities)` in `release-gate.mjs` is the protected host
composition interface for #65. It is a program API, with no CLI, environment
fallback, automatic trigger, tag mutation or Release mutation. The host calls the
returned async function with an array containing exactly one strict SemVer string
(without a `v` prefix). The result is `{ outcome: 'blocked', reason }` with no
handoff, or `{ outcome: 'ready', handoff }`.

The protected host supplies these capabilities, outside candidate/scenario code:

- `expected`: the trusted `repository`, `workflow` path and `environment` names.
- `verifyInvocation()`: independently authenticates the current invocation and
  returns `authorized: true`, those three context fields, nonempty string `actor`,
  `runId`, `attempt`, `event: 'workflow_dispatch'`, and `ref: 'refs/heads/main'`.
  It must reject synthetic evidence and authenticate the actor, approval and
  protected context. Do not build this function from ordinary caller input, an
  approval boolean, PR payload, or unverified environment strings.
- `observeConflicts(version)`: obtains complete authoritative conflict observations
  for each repository in `source-checkout.mjs`. Each observation contains
  `repository`, the exact `version`, `complete: true`, and `tags` and `releases`
  arrays of matching names, plus an `activePublications` array of conflicting
  active publication identities. Include all version aliases (including `v` prefixes)
  and all conflicting Releases, including drafts. Exhaust pagination and reject
  access failures. Empty arrays mean verified absence; unavailable or partial
  enumeration must throw or return `complete: false`. This includes unknown active
  publication state. The gate calls this capability before acquisition and again
  after mandatory E2E and release preparation; each call must obtain fresh
  authoritative observations.
- `observeMains()`: freshly reads each official repository's remote main and returns
  one row per repository, with `repository`, `ref: 'refs/heads/main'`, `commit` and
  `complete: true`. Missing, partial or unavailable reads must throw or report
  incomplete. The gate compares these remote observations with the acquired commits
  before and after E2E and after release preparation. Unchanged local identity
  fields cannot replace these reads.

These functions are privileged process capabilities, not JSON authorization
claims. There is no default identity service or observer, and no test substitute
in production composition. Workflow Environment enforcement, concurrency and
publication-condition rechecks remain #65 and the coordinator's responsibilities.
The host must not expose this composition API to an untrusted candidate or grant
scenario processes publication credentials. Workers receive an empty environment
and only the prepared sources, never the capabilities. Worker threads are not an
OS security sandbox: the protected host must maintain filesystem/process isolation
and keep credential files unavailable to scenario code.

All maintained coverage-catalog entries are mandatory release requirements. Every
product must have requirements, every requirement must map to registered runnable
scenarios, and every selected scenario must pass. The gate reuses coverage document
validation; provenance strings and evidence URLs cannot authorize release. The
current catalog is unmapped, so production is intentionally blocked before source
acquisition. Synthetic wake or contract fixtures do not supply those mappings.
Production scenarios are separate work.

The gate owns one `prepareSources()` set. It resolves each official current main
once, prepares producer outputs with the existing compatibility checks, and passes
the same set to `run`. It retains that set through handoff construction and checks
identities again after execution. Settled resources are disposed before returning;
disposal failure blocks success. Core's local `main` is bound to its acquired commit
without refetching; Action and CLI keep detached checkouts. Unknown worker or producer
process-group termination blocks success and
retains sources for host recovery instead of deleting potentially active outputs.
The host must supervise process death and recover retained resources; an interrupted
or non-returning invocation is never a successful preflight.

`CoordinatorHandoff` is defined alongside `validateHandoff` in
`release-contract.mjs`. Version-1 handoffs contain the validated version, verified
invocation identity, exact three source identities, mandatory passed scenario IDs,
mode, and confirmed disposal state. They contain no credentials, checkout paths or
prepared outputs. The handoff is identity-only: outputs have been deleted and must
not be consumed downstream. The coordinator must acquire those exact identities
if it needs sources, never substitute newer main, and recheck publication conditions
before publishing. Handoff validation checks structure; it does not authenticate
an arbitrary serialized document. Only a handoff received directly from the trusted
gate invocation is evidence of that invocation's success.

`createContractGate(capabilities, dependencies)` is explicit credential-free test
composition. Its dependencies include `catalog`, `registry`, `prepare` and `run`.
Its handoffs always carry `mode: 'contract-test'`; a coordinator must reject them
for publication. Production composition has no dependency overrides. Contract
success is implementation evidence, never live release or installation evidence.

After mandatory E2E, the retained source owner invokes `prepareRelease` exactly
once. `release-producers.mjs` requires all product-owned producer entries and fresh
staging before invoking them sequentially. `release-staging.mjs` checks Core's
versioned pin, archive and checksum, then reuses Core's installer/content verifier.
It reuses Action's release-tree validator and checks prepared package/lock versions,
entry and Node runtime. It checks all six CLI executable headers, target identities,
sizes, hashes, manifest and complete checksum inventory. Producer failures, malformed
success, missing outputs and incompatible consumer declarations block readiness.

Core's ordinary test package is moved outside its checkout into the same owned
root so its release producer can require a clean local `main`. Consumer pins still
identify that exact versionless package used by E2E. The release package carries
`releaseVersion` and therefore has different manifest/archive hashes; its native
installer verifies it against its own versioned pin and the acquired Core commit.
No consumer pin is rewritten. Action alone may change disposable package/lock
version fields; other maintained-source changes are rejected. No source commit,
tag, Release or publication operation is performed. Outputs and the verification
installation are disposed with the source owner. Unknown termination retains the
whole root for trusted recovery and blocks readiness.
