# Runner scenarios

`npm run e2e -- --group runner` uses the framework's current-main source owner,
including producer compatibility checks. Preparation compiles the maintained Go
consumer in the CLI module so it can import the actual `internal/cli.App`.
The source owner executes the consumer under a bounded process group and saves
its observations before workers start. Workers read and verify that report;
they do not own child processes. Producer files and lifecycle implementations
are not replaced. The consumer
injects controlled API, download, Process and RunnerHost inputs. Its synthetic
archive is never executed. No login, native Runner, Docker daemon, host service
or official GitHub registration is used by this scenario.

The scenario checks registration, list, remote removal, local unregister,
repository and label misbinding, denied administration, unknown registration,
busy/active/service/mismatched cleanup, unavailable runtime/package/tools/Docker,
and host preflight. It retains command exit codes and the full JSON stream,
local configuration identity and native controlled identity. Each report says
`controlled`; passing is contract evidence, not live E2E or protected isolation.
Preflight exit 2 and protected-execution-unverified remain required outcomes.
Only Linux amd64/arm64 controlled hosts are implemented. Windows/WSL and other
combinations remain unverified or unsupported.

## Protected execution call surface

`protectedRunnerScenarios({ sources, context })` in `runner-live.mjs` is callable
by the existing protected execution owner, outside ordinary scenario workers.
It exposes `setup()`, `inspect()` and `cleanup({ remoteOnly })`. It has no CLI or
worker entry point and obtains no credentials. It invokes the prepared actual
CLI through the owner's bounded `command(entry, args)` executor, which returns
`{ exitCode, stdout }`; raw stderr and exception diagnostics are excluded.
The executor must run that executable with the protected actor's own authorized
provider/host access. Controlled executor tests are not live-provider evidence.

The protected context binds `target: { repository, repositoryId, actor }` and
supplies `authorize`, `exclusive`, `allocate`, `receipt`, `inspect`, and `idle`.
These are capabilities, never scenario JSON or ordinary worker data. Authorization
must independently check the bound actor/target and each operation. `exclusive`
provides durable state and an awaited `save()` under an exclusive lock. Preserve
that state for recovery; do not replace it with a new empty inventory on retry.
`allocate` must journal a fresh private disposable allocation. `receipt` must
prove the native registration was created by this execution and bind its ID.
Names, labels, copied metadata and Issue/PR fixture ownership are insufficient.

`inspect` supplies independently observed repository/member identity, managed
Runner ID, local `{agentId, agentName, gitHubUrl}`, native Runner identity, usage,
service status, remote absence and local configuration presence. `idle` must
check actual process/service/dependency use, rather than trust an offline label.
Missing or mismatched proof blocks cleanup. Unknown writes retain pending state
and are never automatically repeated. Recovery belongs to the existing protected
execution process. Remote removal retains local configuration; unregister is a
separate operation. The allocator retains files until that process confirms
registration retirement, no active use and disposable ownership. These helpers
do not delete live directories or manage services.

Live results include the actual prepared source and target; protected execution
remains unverified. No live invocation or Windows/WSL claim is made by local tests.
