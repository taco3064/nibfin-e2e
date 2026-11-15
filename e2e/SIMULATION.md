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
those trees on a timeout alone.

## Lost replies and restart recovery

Trusted tests may pass `{ controls: { dropReply(operation, repository) } }` to
`createSimulatedSuite`. Returning `true` drops a reply **after** a `create`,
`trigger` or repository `remove` commits. Ordinary `run` requests cannot select
these controls. The trace records both the committed operation and `reply-lost`;
count `observed` mutations to check that recovery never repeats the write.

Use `await suite.restart()` to discard the composition and recreate the provider
client and inventory handle. This copies independently retained simulated remote
state, including original creation receipts and dispatch evidence, while keeping
the original durable inventory, source owner and prepared source paths. The old
composition can no longer run or dispose these resources. Controls are not carried
across restart; tests can supply fresh controls to `restart` if needed.

Resume with the original run ID. Creation uses the independently bound original
operation receipt; deletion uses affirmative, independently bound absence.
Delivery reconstructs read capabilities from retained legs and independently
checks wake, concurrency, delivery and merged-source evidence. It never reenters
the producer or dispatches a replacement. The lost dispatch regression drops the
second reply, after both originally intended dispatches have committed. Missing
original dispatch evidence, missing Run ID, ambiguous absence, denied observations
and foreign bindings remain non-passing Pending. Retained resources cannot be
cleaned up while interrupted creation or dispatch reconciliation is unresolved.
Later adequate evidence settles the same suite and operation intents; cleanup
then removes only owned resources. These regressions run in `npm run verify`
and remain controlled evidence, not real-provider recovery certification.
