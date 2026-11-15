# Offline suite composition

`createSimulatedSuite()` in `simulated-suite.mjs` creates one local provider,
empty filesystem inventory and fixed prepared source owner. Call `run` with the
existing `{ runId, phase, resume }` suite request. Omit `phase` for the complete
provision/install/delivery/failure/cleanup chain. To select phases separately,
keep the same object and run ID, and set `resume: true` after the first call.
Missing prerequisites retain the suite's existing specific diagnostics.

The provider models public disposable repositories. Provisioning, installation,
paired delivery, failed-CI recovery and teardown use the maintained drivers and
validators. Provider operations update the same repositories, issue observations,
workflow runs, jobs, checks and PRs that subsequent readers observe. Installation
has two shared slots on the primary repository and no peer registrations.
The local merged tree contains the fixed harmless JavaScript program; the
maintained merged-source assertion executes Node and compares exact stdout.
Its Git command capability reads simulated merge metadata without creating a Git
repository. This is controlled simulation, including synthetic installation and
fixture-mode callers. It cannot satisfy `requireNativeSuite` or establish real
GitHub, Runner, release or self-delivery evidence.

`trace()` returns a defensive copy of operation evidence correlated with suite
run, phase, resource owner and original source owner. Evidence remains available
after resource cleanup and `dispose()`. `provider` exposes the same local state
for trusted simulation composition and diagnostics; these capabilities never
come from run requests. Network operations are refused with
`SIM_NETWORK_FORBIDDEN`. No live GitHub or production host capability is composed.

After completing cleanup, call `dispose()` to remove the owned source outputs
and inventory directory. Merged execution trees are removed immediately after
confirmed process termination. Disposal refuses while execution/effects remain
unknown or owned repositories/registrations remain. Unknown process trees stay
listed in `provider.localResources` for the caller's recovery; do not delete
those trees on a timeout alone. Keep the object and its inventory for continuing
selected phases. Restart recovery after lost write replies belongs to SIM-02;
this composition reconciles known completed work without redispatching it.
