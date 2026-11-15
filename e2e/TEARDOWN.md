# Protected run teardown

`protectedRunTeardown({ inventory, context, bounds }).teardown()` consumes the
existing exclusive fixture inventory. It does not invoke host tools or acquire
credentials itself. Only the protected executor may construct `context`; never
accept these capabilities, targets or observations from scenario input or command
output. Bounds use `fixtureBudget` and apply to every external capability call.

The result is `complete` or `unresolved`, with a bounded phase and reason. A local
synthetic result always leaves `protectedExecution` unverified. Operations expose only bounded identities and verified/unresolved dispositions.
No provider errors,
command output or credentials enter results or the teardown recovery record.

## Protected capability contract

Every asynchronous capability receives `{ signal }` as its last argument (except
existing credential and fixture APIs). Cancellation requests do not establish
termination. Adapters must respect finite budgets and supply independent reads.

- `authorize(definition, options)` confirms the current account, host and run's
  destructive authorization. Only literal `true` permits work.
- `exclude(definition, options)` installs a durable run-owned dispatch fence.
  All relevant provisioning, installation, delivery and test dispatch producers
  must consult this fence before starting work. It survives executor termination
  and remains installed after teardown. The coordinator never releases it.
- `execution(state, options)` independently returns `excluded`, `settled` and
  `effects: 'reconciled'`. Settlement includes producers, consumers, runs and all
  outstanding commands or intents in the complete supplied inventory, including
  teardown operations. A cancelled
  GitHub run alone is insufficient. No delivery run is a valid settled condition.
- `mutate('settle', null, state, options)` settles or cancels relevant executions
  while retaining the fence. The coordinator persists the intent first and then
  requires independent execution read-back.
- `discover(state, options)` returns `{ complete: true, targets }`. Discovery must
  account for every installation and delivery service, file group and registration,
  including partial installation, pending commands and native creation receipts.
  Empty discovery is valid only with affirmative complete observation. Targets
  have `kind` (`service` or `registration`), bounded native `id`, `hostId`, and the
  exact run `owner`. A service target identifies its complete owned file group.
  Recorded Runner IDs must be present. Previously discovered targets remain in
  subsequent discovery, including when absent. This is observation, not a second
  resource registry; identities are retained in the existing inventory.
- `observe(target, options)` returns fresh `independent: true`, `complete: true`,
  all four exact target identity fields and explicit `owned`, `active`, `stopped`
  and `absent` facts as appropriate. Affirmative absence requires sufficient native
  access and complete enumeration; access denial or ambiguous not-found must not
  produce absence. `absent` and `active` must be explicit booleans; services
  additionally require a boolean `stopped`. Absence cannot coexist with activity,
  and a stopped service cannot be active. Contradictions remain unresolved before
  any terminal state is accepted, including on retry and after mutation.
  Matching names or markers alone cannot establish ownership.
- `mutate('stop' | 'remove', target, state, options)` uses only independently
  verified native ownership. Stop precedes removal of a service's files. Removal
  requires inactive targets; service removal additionally requires stopped state.
  Missing, unrelated or ambiguous targets must never be mutated by the adapter.
- `repository(record, definition, options)` uses a separate independent observer
  and returns `independent`, `complete`, `access: 'verified'`, exact `repository`,
  recorded native `id`, `accountId` and either affirmative `absent` or `native` in
  the existing repository adapter's native format. An absence proof must bind the
  exact recorded identity and disposable account, not merely a repository name.
- `receipt(record, definition, options)` recovers a lost creation response using
  protected native provenance bound to the exact provisioning `operation`.
  Marker discovery is insufficient. Unknown creation without a receipt remains
  unresolved, even if no matching repository can currently be listed.
- `deleteRepository(record, definition, options)` deletes the exact verified native
  target. The coordinator excludes the credential-validation repository and checks
  the disposable account, generated target, native ID and run marker before calling.
- `credentials` is the original private `fixtureCredentials` session. Its existing
  `revoke()` semantics must verify helper revocation; it never revokes the User
  login. Missing sessions and uncertain issuance remain unresolved. A verified
  terminal revocation is retained. A lost response can be reconciled through the
  original session's `capabilities().automation.status === 'revoked'` metadata.
  An unresolved revocation is never replayed.
- `fixtureProvider` and `fixtureContext`, when ordinary Issue/PR/ref resources exist,
  use the existing `fixtureLifecycle` APIs. Reconciliation and cleanup run under
  the already-held inventory lock, preserving merged history and existing ownership
  checks. These APIs must independently validate idleness and absence as before.
- `baseline(state, options)` independently compares the approved non-test Runner
  baseline with current native host state. Literal `true` is required both before
  host mutations and at completion. The approved baseline belongs to protected
  composition; inventory or scenario data cannot select it.

## Recovery

Every write has a flushed intent before invocation. Retrying teardown first reads
native effects; a prior write with no independently observed terminal effect is
never repeated. Protected recovery must resolve that specific operation before
continuing. Completion is recomputed on each invocation, including late inventory
additions. Provisioning and installation bindings are preserved.

If a bounded call returns while its underlying promise is still pending, the
inventory lock file is retained, even after that promise eventually settles. Do
not automatically break it. Only protected recovery with independent termination
and accounted-for effects may retire that ownership lock. Ordinary calls preserve
existing inventory lock behavior. Recovery state must remain outside disposable
worker roots; no worker cleanup removes it.

The protected acceptance executor supplies real native operations and independent
baseline observations later. Unit tests of this interface are not live host proof.
