# Writer pressure observations

`pressure.fixture` in `pressure-contract` runs controlled histories and actual
prepared Core `writerCapacity` / `acquireWriterCapacity` calls. It requires a
prepared Core checkout through the existing scenario source context. Controlled
Linux file locks and injected memory, waits and clocks exercise healthy shared
admission, draining before exclusive admission, and five-minute pressure expiry.
They do not exhaust host memory, start guests, or certify WSL support.

`observePressure(binding, evidence)` is a pure observer. Binding includes the
request, repository, issues, member, experimentId, phase and clockId, with
`case: 'pressure'`. Phases are healthy, serial, expired, recovered and pending.
Evidence extends the binding with the existing complete admission/Writer history,
coverage, samples, diagnostics, effects and independentEligible. Recovery uses the
existing interrupted concurrency contract (prior/replacement, confirmed retirement,
reconciled effects, continuing authorization and confirmation time).

Every timestamp uses the explicitly named experiment clock in milliseconds.
Samples carry experimentId, clockId, Run repository/ID, attempt, Job ID, at and the
actual Core mode. Modes are observations, never a second capacity policy.
Diagnostics carry the same correlation fields plus executionId, handshakeAttempt,
elapsedMs and code. `JOB_VM_EXEC_INITIALIZE_TIMEOUT` is the native Core Writer
initialization diagnosis. `WSL_CONNECTION_TIMEOUT` is a distinct normalized
connection observation supplied by a test-host adapter, not a claimed Core log
string. Inner attempts refer to one Writer execution. Pressure expiry uses
`JOB_VM_HOST_MEMORY_PRESSURE`, a null executionId and handshakeAttempt zero;
waitBoundMs must be 300000 and multiple waiting samples must cover that interval.
Writer ends mean confirmed guest retirement, not terminal GitHub Job states.
Missing or contradictory history cannot pass. Pending observations retain the
recovery requirement and never conclude recovery success.

## Separately adopted test host

Call `runPressureSmoke(binding, host, limits)` outside ordinary scenario workers.
No protected callbacks or credentials enter the registry. Supply all finite
positive limits: timeoutMs, requestTimeoutMs, requests and operations. Callbacks
receive an AbortSignal and must honor it; a timed out mutation is never replayed.
The driver cannot stop a remote operation merely because its response times out.
It reports unknown effects and retains recovery state instead of cleaning blindly.

The explicit host capability object must declare adoptedTestHost true and
production false. It implements these bounded callbacks:

- `inventory(binding, signal)` returns complete and activeGuests (stable IDs).
- `experiment(binding, constraints, signal)` executes the adopted experiment via
  Core and returns experimentId, reconciled effects and an owned resource inventory.
- `observe(binding, signal)` returns the pressure observation contract above.
- `cleanup(binding, resources, constraints, signal)` returns complete and reconciled
  effects after removing only the supplied owned disposable retired resources.

Constraints preserve existing active guests and prohibit WSL restart or
reconfiguration. The capability implementation must enforce those constraints;
this module supplies no shell, host administration, production fallback or new
admission authority. Resource records require id, owner equal to experimentId,
disposable true and retired true. Existing active guests are excluded. Inventories
before and after cleanup must still contain pre-existing active guests. Unknown
ownership, active Writers, effects, preservation or cleanup prevent success.

The returned evidence level is test-host-observation; liveVerified remains false.
A callback result is not native provenance. The separate authorized WSL verifier
must supply actual kernel, host and GitHub Job evidence and independently establish
supported-host behavior. Unavailable capabilities return CAPABILITY_UNAVAILABLE;
missing evidence returns unverified. No native host was adopted by these tests.
