# Isolation selections

`isolation.local` exercises Core's prepared current-main Runner fixture, binding
reader, generated role plans, Docker endpoint/socket validation and network-policy
functions. Its observations are synthetic contracts, not OS enforcement. No socket
is opened, protected path read, cross-role write attempted or network probe sent.
The synthetic socket host is an in-memory observation, not an incidental host path.

Claude coverage invokes the prepared Core adapter, plans, fixed workspace-channel
binding, private runner and worker. Five role plans and adapter executions cover
Deliver, Shape, Shape validation, Accept and final review. Only Deliver receives
writable workspace mounts. Authorized reads/checks and Deliver writes reach a
controlled executor; unauthorized writes, unsupported operations and foreign
execution identities are rejected before dispatch. Untrusted issue text cannot
replace trusted executable or MCP configuration.

Controlled command inputs and effective container inspections include valid
controls plus mutations for writable review mounts, extra host/authentication
mounts, Docker socket exposure, credential environment, network attachment, DNS,
and model executable/MCP substitutions. Commands are captured in memory; the
fixture never invokes Docker, Claude, Python, a provider or protected host probes.
These observations test maintained policy decisions over synthetic inputs, not
actual OS enforcement, authentication, installation or platform support.

Unknown model and unknown worker termination are driven separately. The private
runner denies retirement/replay and retains admission/channel resources; the
adapter retains its actual RoleSessions lease and denies replay without executing
again. Controls then restore known termination and settle both sides before
removing owned resources. Successful role executions retire, remove their leases,
and permit a distinct subsequent execution. This exercises Core lifecycle state;
it does not claim a live host Writer-replacement audit.

Every Claude category must complete for local verification to succeed. Public
results contain category counts and source identities, never captured commands,
fake credentials, private paths or imported exception text. Temporary sessions,
mount directories and copied egress sources are fixture-owned and removed after
controlled settlement, including assertion and setup failure paths.

`isolation.host` exposes host-path, credential, role-write and network selections.
Workers intentionally have no protected sandbox executor. On Linux these checks
are blocked pending authorized protected-runner probes. Other OS behavior is
unverified. Missing prepared Core blocks either selection. A source checkout,
worker claim or denied-looking exception cannot establish host enforcement.
Core's maintained sandbox preflight and managed probe construction remain with
the protected runner; these scenarios do not invoke Docker or install a host
adapter. No host isolation coverage is claimed by this implementation.

Result messages identify the actual OS, Node runtime, observed source identities
and execution mode. Imported local failures use a fixed diagnostic instead of
provider exceptions. The framework executor owns temporary directories and
worker termination;
Claude helpers also settle and remove their own temporary resources. Cleanup
failure overrides success. No scenario creates a detached process or live
credential sentinel.

Run `npm --ignore-scripts run verify` for local regression checks. Real Core
contract execution requires the existing prepared source context and can be
selected with `npm run e2e -- --group isolation.local`. Host selections remain
visible with `--group isolation.host` and return non-success while unavailable.

Issue #90 adds a protected library entry, `observeIsolation` (also exported from
`isolation-host.mjs`). It does not enable the ordinary host selections. Its caller
must explicitly supply authorization, a #88 `InstallationResult`, native GitHub
transport, fixed negative/eligible launch operations, independent Core rejection
and slot readbacks, owned sentinel creation and confirmed process termination.
There is no default protected caller and no worker context field enabling one.

The caller's `authorize({binding, expected, signal})` must return exactly `true`.
`openSurface(signal)` returns the capability from `disposableSentinels` using a
caller-owned disposable parent. Its `reserve(run)` tokens are object capabilities;
only the authorized launcher may receive `target(token)` to arrange the actual
Job's sentinel write. `executeNegative` and `executeEligible` receive
`{case, assignment, sentinel, signal}`. They must own deadlines and cancellation,
including launched descendants. They do not accept worker-selected commands,
paths, endpoints or destinations. Creation and cleanup must remain on that owned
surface. Interrupted surface creation is also the caller's recovery obligation.

`readRejection({assignment, signal})` reads the actual Core classification as
`{verified, category, assignment, rejectedAt, reference}`. It must not manufacture
classification from expected values, an exception or native Job failure.
`readSlot({assignment, signal})` returns the observed hostId, slotId, runnerId,
memberId and repositoryId for that Job. Slot IDs come from actual protected slot
binding; they are not inferred from labels or the order of installation runners.
`provider` uses the existing GitHub observer transport interface. Every assigned
Run and attempt-specific Job collection is independently read and compared.

The expected contract supplies case, explicit applicability, negative and eligible
assignments and slot binding. Each assignment includes repository, Run ID,
attempt, Job ID, numeric Runner ID and name, workflow ID and path, source SHA,
event and head repository. Expected identities and native observed identities
remain separate in the sanitized result. Fork/route inapplicability is explicit
and does not count as rejection. Unknown cases, missing fields, incomplete
collections, missing steps, skipped or ambiguous steps and unclassified failures
remain non-success. Zero execution requires an explicit empty native steps array.
Any executed negative step or present owned negative sentinel contradicts rejection.

Eligible recovery requires a different subsequent Run on the same actual Runner
and slot, observed successful step execution and its own unique sentinel. The
adapter reinspects sentinels after `terminate(signal)` confirms termination and
before cleanup. A separate bounded recovery budget remains available after an
acquisition timeout. Uncertain termination retains the disposable surface for the
caller's authorized recovery; uncertain termination or cleanup prevents success.
The caller must retain its own recovery inventory, including timed-out creation
or launch operations; this observer never retries a launch automatically.

`compareAdmission` is a pure evidence comparison, not a protected capability.
Synthetic observations return `state: synthetic`, never live success. Live mode
requires independently supplied operator installation observations and protected
callbacks; installation readiness alone never proves protected execution. Tests
use in-memory GitHub responses and synthetic installation producers, not live
GitHub admission or host enforcement. The installation's `protectedExecution`
remains `unverified` and is never promoted or mutated by this adapter.

`exerciseSyntheticCanaries` covers peer registration, controller credentials,
host paths, Docker and disallowed egress with disposable in-memory tokens. It
reports expected-denial, unexpected-access or unavailable, always marked
synthetic. It never reads actual registrations, credentials, host paths, sockets
or networks. Denied-looking exceptions become unavailable; only explicit observed
denial establishes the synthetic contract. Raw probe/provider diagnostics and
synthetic secret values are omitted from all public comparison results.
