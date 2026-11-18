# Controlled Dashboard regression

`dashboard.integration` exercises Core's maintained `collectLocalWork` and
`collectDiagnosis` seams through the CLI's actual `dashboardObserver` and
`dashboardDiagnoser`, then the snapshot decoder and overview aggregator. The
E2E-owned Go drivers are added only to a disposable CLI copy. Core's existing
synthetic GitHub transport fixture supplies external facts; E2E assertions do
not invoke upstream test assertions. Core itself performs correlation, Pause
classification, report selection, native identity checks and diagnosis refusal.
No installed host or production credential is simulated as an authorized host.

The cases include zero, one, two and four registrations, installed adoption and
consumer deduplication, idle/busy/offline, assigned without admission, queue entry,
live stage changes, paused, dependency blocked and Unknown observations.
Idle cases assert every registration's state at both the decoded Core/CLI
observation and the overview projection, including shared registration deduplication.
Counts or admission status alone cannot satisfy the idle-state assertions. A second
repository with the same Issue number cannot inherit the first Issue's evidence.
Stale attempts cannot establish live execution. Native termination observations
and attributed Agent explanations retain their Issue and attempt binding,
historical status and missing evidence. Explicit diagnosis without authorized
capacity runs the real Core refusal path. Changed subject, repository and node
identity are refused before Core invocation. Native Pause/Resume uses the actual
CLI adapter and controller; requested labels and observed results remain distinct
from a final Core verdict, including ambiguous submissions.

`dashboard.browser` uses the real Dashboard HTTP handlers and embedded assets,
with an E2E-owned loopback fixture. The CLI's maintained browser host mechanics
and diagnosis decoder helper are reused without changing producer declarations.
Browser collectors supply controlled presentation observations and diagnosis
outcomes; they do not prove native collection or Agent execution. Cases cover
confirmed and missing evidence, denied/no-capacity/unavailable diagnosis, fixed
same-Issue Pause/Resume, review invalidation on selection changes, and stream
disconnect/reconnect retaining selection, search state and the document.

## Execution

The ordinary registered entry is `npm run e2e -- --group dashboard`. Existing
`--source ID=REVISION` selection and compatible-source verification remain in
effect. Results identify the sources through the normal E2E report. Dashboard
runs explicitly put both preparation and execution beneath
`e2e/.dashboard-work/`; Go, npm, browser and temporary output use owned paths.
Prepared producers and their declarations are never rewritten. Services and
browser processes finish before fixture removal; the parent-owned native
dispatcher preserves termination-unknown retention.

The browser scenario requires the prepared CLI's maintained package/lockfile and
an installed browser. Its parent-owned command uses the producer's existing
`npm ci --ignore-scripts --no-audit --no-fund` provisioning, then builds the
controlled service and runs the E2E cases. Dependencies and caches stay inside
the disposable copy. Hosted execution uses installed Chrome without browser
downloads, as the producer does. Missing maintained entry points are `blocked`;
an unavailable browser launch is `unverified`.
Neither counts as passed. Failures after a successful launch fail the scenario.
Hosted wiring, if needed, belongs to the protected workflow maintenance route.

Focused framework checks are
`node --test e2e/test/dashboard.test.mjs e2e/test/registry.test.mjs`.
The maintained `runIntegration(context)` component can also be exercised with
the supplied compatible read-only Core/CLI snapshots and a repository-local
`context.tempDir`. This checks native adapter behavior without Git-dependent
producer packaging. It does not establish prepared package compatibility.

The assigned Deliver environment has no browser automation capability. Browser
execution, full `npm run verify`, Git-dependent preparation, independent Accept
and applicable PR CI remain **Unverified** until their owners run them. Controlled
regression results do not certify a live host, release or platform combination.
