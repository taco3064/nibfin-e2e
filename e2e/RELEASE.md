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
  arrays of matching names. Include all version aliases (including `v` prefixes)
  and all conflicting Releases, including drafts. Exhaust pagination and reject
  access failures. Empty arrays mean verified absence; unavailable or partial
  enumeration must throw or return `complete: false`.

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
disposal failure blocks success. Unknown worker termination blocks success and
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
