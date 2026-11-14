# Native dependency scenario

`runDependency(request, caller, bounds)` in `dependency-protected.mjs` composes
fresh owned upstream delivery and downstream continuation. It is a protected
library, using the same request and delivery callbacks as `runDelivery`.
Live requests target this repository only. `dependency.live` in group `dependency`
returns a specific blocked prerequisite in ordinary credential-free execution.
Controlled tests use `mode: 'fixture'` and never establish live verification.

The protected caller supplies the existing delivery capabilities plus:

- `createFixture` returns `{definition, inventory, lifecycle}` using the existing
  durable inventory and lifecycle implementations. Two distinct definitions,
  inventories and newly created Issues are required. No preexisting Issue can be
  adopted by number or marker. Store inventories outside ordinary workers.
- `admitDependency(binding, signal)` invokes the existing authorized Core
  admission/continuation path. For `after`, read the existing upstream fanout or
  use the single authorized continuation path; never dispatch again when its
  effect is unresolved. It establishes eligibility only through protected
  authorization. The scenario never grants it. For `dispatched`, return the
  actual downstream invocation identity, not the fanout scheduling Run. Other
  decisions may identify the Core evaluation in the upstream fanout Run.
- `readDependencyEvidence(binding, signal)` independently reads the protected
  Core admission result, returning `{admission}`. Never synthesize evidence from
  the request or dispatch response. Missing capability or unsupported extraction
  must remain unavailable; do not invent a replacement execution mechanism.

The binding contains fresh `requestId`, `repository`, `upstreamIssue`, downstream
`issue`, `upstreamRequestId`, and `phase` (`before` or `after`). After eligible
upstream completion it also contains `continuation`, the upstream wake identity.
Admission response and observed record must contain matching binding fields,
`runRepository`, `runId`, `attempt`, `jobId`, `invocation`, `decision` and `reason`.
`reason` is a bounded diagnostic identifier from Core, never raw protected data.
The observed record additionally requires `authorized: true`, `executed: true`.
For `after`, it must independently associate `continuation` and `originEvent`
with that upstream execution. The origin is read natively using its actual
repository, Run and attempt; no Issue-origin event is assumed for fanout.

Decisions are observed Core outcomes: `blocked`, `eligible`, `ineligible`, or
`dispatched`. Before completion, only `blocked` with a real protected invocation
and native incomplete edge establishes blocked admission. After completion,
`blocked` and `ineligible` remain explicit non-success outcomes. `eligible`
without actual invocation remains unresolved. A dispatched outcome requires
native downstream Run/attempt/Job execution with a legal dispatch event and its
associated protected record. Queued work, empty scheduled responses, copied
upstream execution, unrelated Jobs and missing observations cannot pass.
Downstream delivery completion is unnecessary; an actual invocation may still
be in progress. Upstream completion uses the full existing delivery validator,
native Closed + delivered and source assertion, never cleanup closure.

Native `blocking` and `blocked_by` collections are bounded paginated GitHub
reads. Exact owned IDs and numbers and both directions are checked before
admission and again after upstream delivery. They remain the dependency SSOT;
this module does not calculate eligibility or maintain another dependency graph.
Live execution prepares current Core/Action/CLI mains once through the existing
source mechanism and supplies them to protected triggers/admission calls.

Dependency mutation intent is persisted before writing through the shared
fixture lifecycle. Unknown writes prohibit replay and require native read-back
through lifecycle reconciliation. Admission intent is separately persisted in
the downstream inventory before invoking Core. An unknown effect preserves that
binding and pair, blocks teardown, and is never automatically retried.
`reconcileDependencyExecution(inventory, caller, bounds)` only reads independent
protected/native evidence to resolve such an intent; it never dispatches.
Unavailable or contradictory read-back retains recovery state. Cleanup still
requires protected authorization and confirmed idle use. Merged history is
preserved; unresolved cleanup retains prepared sources for the protected owner.
No credentials, raw receipts or host paths enter public results or workers.

Run local verification with `npm --ignore-scripts run verify`. These controlled
checks do not prove live GitHub fanout, host capability or release readiness.
