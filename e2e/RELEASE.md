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

## Publication coordinator

`createPublicationCoordinator(capabilities)` in `publication-coordinator.mjs` is
#39's protected composition API for #65. Call it with `[version]` for a fresh run
or `[version], { resume: true }` for recovery. It has no CLI or workflow trigger.
It constructs the production gate itself; it accepts no caller-supplied handoff.
The gate's optional protected `consumeRelease` callback captures validated content
before disposal. The coordinator persists that content and starts publication only
after the gate returns successfully with confirmed cleanup. No disposed path is
read. Resume uses the original content, not a new checkout or a newer main.

In addition to the gate capabilities, composition supplies:

- `native`: `createGitHubPublisher({ token })` from `publication-github.mjs`.
  Keep this object and its installation credential outside scenario/Candidate code.
  Its requests address only the three official repositories, Git object/ref APIs,
  Releases and release assets. It never deletes or replaces published objects.
- `verifyConditions(handoff)`: freshly verifies the authorized original version
  and sources, current release authorization, isolated protected environment,
  serialization and absence of competing publications. Return exactly `true` only
  when publication remains allowed. It must account for this run's own partial
  objects on resume; requiring empty version state would prevent safe recovery.
  It runs on every invocation and immediately before every write. It must not
  substitute current main for the original sources on resume.
- `evidence.load(version)` and `evidence.save(record)`: the approved protected
  Actions evidence adapter. Save must durably acknowledge the entire record before
  resolving. Load must return the latest acknowledged run-scoped record, or `null`
  only for a proven fresh publication. Missing, expired, inconsistent or unavailable
  evidence for an existing run must throw; it must never masquerade as fresh state.
  Composition binds this store to the authorized run/version and makes it inaccessible
  to scenario code. No database, scheduler, credentials or arbitrary input document
  is used as recovery authority.

Recovery contains source/invocation identities, the validated asset bytes, their
content digests, the intended Action Git objects, and operation intents and native
object identities. Asset bytes are retained because regenerating deleted builds
could change content. Only this evidence remains after source/staging disposal.
Retain it through unresolved effects and the authorized recovery lifecycle; settled
source roots and verification installations are removed by their existing owner.
The content digest checks consistency within this record; it is not authorization.

Each potentially effectful request follows a durably saved intent. The native
adapter never retries writes. After a write, the coordinator independently reads
its native object before advancing Core → Action → CLI. Asset verification downloads
and hashes the actual native bytes. Unknown requests/readbacks stop publication;
resume freshly observes native state and proceeds only after establishing a match
or authoritative absence. A matching visible object without this run's intent is
conflicting state. Completed operations are reverified and are not duplicated.

Action publication creates immutable metadata blobs, a root tree preserving all
other entries, and a deterministic release commit whose parent is the gated Action
source. Only the two validated package version files differ. The release tag targets
that commit; product main and consumer pins remain unchanged. Core and CLI tags
point directly to their gated commits. Core uploads its archive, pin and checksums;
CLI uploads its six validated targets, manifest and checksums. All use `v<version>`
tags and Releases named with the common unprefixed semantic version.

Results expose `completed`, `failed`, `unresolved` and pending repositories on a
publication failure. No cross-repository rollback or atomic completion is claimed.
`createContractCoordinator` is an explicit credential-free test seam; its results
carry `mode: 'contract-test'`. Controlled success is not public-release evidence.
Production coverage remains unmapped and blocks live publication. #65, actual
mandatory E2E/preflight, protected composition and separate release authorization
remain prerequisites for a real release.

## Manual entry and protected-maintenance handoff

`releaseEntry(env, request, protectedCapabilities)` in `release-entry.mjs` routes
`env.NIBFIN_RELEASE_VERSION` through `createPublicationCoordinator`, which builds
its own production gate. Only this single strict semantic version is ordinary input.
The entry accepts no serialized handoff, dependency selector or environment-based
authorization. It returns the coordinator's bounded result. The standalone executable
has no protected capabilities and exits blocked; environment claims and observation
credentials cannot enable publication.

A separately authorized protected-maintenance PR must supply the following isolated
in-process capabilities. The current workflow does **not** configure them, durable
recovery storage or publication credentials. Its read-only observation token is not
publication authority. No protected workflow changes are part of this implementation.

- `verifyInvocation`: the independently authenticated protected-main dispatch,
  Environment approval, actor and original run identity described above. Authenticate
  native context; do not interpret environment strings as proof. The entry fixes the
  repository, workflow and Environment to the maintained release workflow and
  `nibfin-release`. It rechecks the same original invocation before each write.
- `request`: an authenticated read-only GitHub transport with complete visibility
  into tags **and draft Releases** in every official repository. If its access cannot
  establish that visibility, do not supply it as an authoritative observation
  capability. `release-observations.mjs` exhausts pagination, includes both version
  aliases and drafts, and rejects failed/malformed reads or bounded pagination
  exhaustion. It never treats inaccessible state as absence.
- `observeActivePublications(repository)`: freshly returns the complete array of
  competing publication identities from the protected serialization authority.
  An empty array certifies absence; unknown or inaccessible state must throw.
  The workflow's concurrency declaration alone is not an observation of activity.
- `native`, `evidence`, and `verifyConditions`: the coordinator capabilities described
  above, with least-privilege publication access only to the official repositories
  and necessary Git objects, tags, Releases and assets. The host may construct native
  access with `createGitHubPublisher`; neither its credential nor evidence access
  may enter a scenario, Candidate process, ordinary environment or request document.
- `resume: true`: a protected recovery decision, never a CLI/environment switch.
  The entry binds the handoff to the original authenticated run and version.
  `verifyConditions` must reconcile the original source identities, serialization,
  current approval and native publications against acknowledged run-scoped evidence.
  During recovery it distinguishes recorded owned objects from competitors using
  native identities and saved intents, never names alone. Fresh empty-state conflict
  checks cannot replace this reconciliation: owned partial tags/Releases are expected.

The evidence adapter must durably acknowledge saves before resolving, bind loads to
this run/version, and return `null` only with authoritative proof of a fresh run.
Unavailable, expired, inconsistent or untrusted evidence must throw. Retain original
content, intents and independent native identities until all uncertain effects are
resolved and the authorized retention period ends. The host owns this operational
retention and recovery; these records are not Candidate artifacts. Do not substitute
newer main or regenerate disposed assets. Unknown process termination retains source
resources under their existing owner. No fresh-run fallback or blind write retry is
permitted.

`releaseContractEntry` is the explicit credential-free composition test interface.
It uses the same entry validation/observation path with the existing controlled
coordinator and fake adapters; results carry `mode: 'contract-test'`. Production has
no dependency override. Controlled success establishes maintained composition only.
Mandatory production mappings remain unavailable, so even a protected composition
continues to block until separately authorized coverage and operational prerequisites
exist. Actual E2E and separately authorized public release remain distinct outcomes.
