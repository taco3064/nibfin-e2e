# nibfin-e2e

The release gate for Nibfin. Scenarios are written only from the Nibfin product
Proposal and drive the product through its public interfaces (`gh nibfin`,
GitHub, Issues and labels) on a real host and real GitHub repositories. The
previous suite is no longer used; its last state is commit `cdcb146`.

## Setup

Node 24 or later. No build step: Node runs the TypeScript sources directly.

```sh
npm ci --ignore-scripts
npm run verify        # typecheck, lint and unit tests (the CI entry point)
```

## Running

Every mode prints one JSON document to stdout; logs go to stderr.

```sh
# Report only, never runs anything (default selection: --all)
npm run e2e -- --list --section 5
npm run e2e -- --uncovered

# Run a selection: --rule and --section are repeatable and combine as a union
npm run e2e -- --rule R5.13 --rule R5.14 --section 3 --gh-nibfin-commit <40-hex sha>

# Run everything (pre-release); adds a gate that needs 100% coverage
npm run e2e -- --all --gh-nibfin-commit <40-hex sha>
```

Only scenarios for the current platform run. Each provisioning step, scenario and
teardown reports `passed`, `failed` or `waiting` (the Proposal is ahead of the
implementation) with a reason. The result's `meta` records the gh-nibfin commit
and the Nibfin image digest `init` pinned (`imageDigest`, `null` when no step
resolved it).

Exit codes: `2` usage or validation error, `1` a scenario or a teardown failed
or the `--all` gate did not pass, `0` otherwise.

## Host provisioning

Execution runs on a fresh GitHub-hosted runner (`ubuntu-24.04` or
`windows-2025`; macOS is not supported yet) with Git, Go, Node and `gh`
installed. The steps run only when a selected scenario `requires` them (directly
or through another step), in this order:

| Step | What it does |
|---|---|
| `gh-nibfin` | Clones gh-nibfin at `--gh-nibfin-commit`, builds `dashboard/` then the binary, and installs it with `gh extension install .` |
| `podman` | Linux: checks Podman. Windows: installs the pinned Podman MSI (sha256 checked) and runs `podman machine init`; `runner add` starts the machine |
| `claude-login` | Writes the Claude token into `env` of `settings.json` in the `nibfin-home-claude` volume, keeping every other key |
| `sandboxes` | Refuses to start while a runner registration is online on the execution sandbox, then resets both sandboxes and reads them back |
| `nibfin` | In a clone of the execution sandbox: `gh nibfin runner add claude --count 2`, `init` on execution then peer; reads the image digest from the init PR, rebase-merges both init PRs and records each sandbox's `main` head and tree as its baseline |
| `observed-job` | Runs one agent fixture on the execution sandbox through Shape, Deliver and Review and records what its Jobs ran with (container projection, probe output, log facts, login volume facts, the pushed branch, how the PR ended) for the scenarios that read it |

After the scenarios, teardown runs for every step that ran, in reverse order:
`runner remove`, then a second reset of both sandboxes, read back to show
nothing is left. It needs these environment variables:

- `E2E_SANDBOX_TOKEN`: fine-grained token for both sandboxes. The harness sends it
  only in its own GitHub API calls and as `GH_TOKEN` to `gh`.
- `E2E_CLAUDE_TOKEN`: the output of `claude setup-token`. It reaches the login
  volume only through a helper container's stdin.

No other child process gets any `E2E_*` variable. Clones and builds go under
`.e2e-work/`, which is deleted at the start of a run and ignored by Git and lint.

The sandboxes are fixed: `taco3064/nibfin-e2e-sandbox` (execution, public) and
`taco3064/nibfin-e2e-sandbox-peer` (private). A reset makes `main`'s tree equal
`sandbox-template/` (with a fast-forward commit), leaves `main` as the only
branch, and deletes every Issue, label, Actions secret and variable, deploy key,
runner registration, ruleset and tag. It closes open pull requests and resets the merge
and pull request settings and the visibility. Collaborators are not touched.

**Only one host at a time may use the sandboxes.** A matrix of hosts must run its
legs one after another (`strategy.max-parallel: 1`). The online-runner check
catches only some overlaps; it does not make concurrent hosts safe.

## Dashboard and site scenarios

`scenarios/dashboard/` starts `gh nibfin dashboard --no-browser` on the provisioned
host and drives it in headless Google Chrome through `playwright-core` (no browser
is downloaded; the host needs Google Chrome, which GitHub-hosted `ubuntu-24.04`
has). `scenarios/site/` checks the public site's Live page and the site's deploy
workflows in gh-nibfin. Elements are found by accessible role, name and visible
text only, and the Dashboard's responses are never mocked or intercepted.

- Browser profiles, temporary files and the browser's `HOME` live under
  `.e2e-work/browser/`. The
  browser gets the host environment without any `E2E_*` variable or `GH_TOKEN`.
  Session proofs and sessions stay in memory and are redacted from every reason.
- Children (`ctx.start`, `ctx.startGhNibfin`) and browsers a scenario starts are
  stopped when that scenario ends, also when it throws: each registers its stop
  with `ctx.defer`, and the runner runs those cleanups after every scenario,
  bounded in time.
- The scenarios create fixture Issues titled `[e2e #298] Dashboard fixture …`
  with `pause` or `pending` in the create call, so none of them is dispatched;
  only fixture E (created by `dashboard-updates`) starts one local Job.
- `dashboard-operations` and `dashboard-updates` require earlier work in the
  sandboxes to have settled: no running Nibfin container, no unpaused `scope` or
  `request` Issue other than the fixtures, and no open pull request or queued or
  in-progress run in the execution sandbox. Otherwise they fail with a
  precondition reason naming what is still active, and assert nothing about the
  product.
- `dashboard-operations` removes and re-adds the claude Runners through the
  Dashboard, leaving two online Runners as provisioning did.

## Coverage map

`coverage-map.json` lists every Proposal rule, in Proposal order, by its `R` id:

- a rule to verify: `{"id": "R5.13", "platforms": ["windows"], "scenarios": ["…"]}`
- a rule the Proposal marks 〔不測：…〕: `{"id": "R0.1", "notE2e": "文件定位"}`,
  with the reason copied from the Proposal. Only the Proposal can exempt a rule.

When the Proposal changes, update the map from the Proposal itself: add new
rules, change 不測 marks, and keep ids as they are (they are never reused).

## Adding a scenario

1. Write it under `scenarios/` as a `Scenario` (`src/types.ts`): an id, the rule
   ids it verifies, the platforms it runs on, the provisioning steps it
   `requires` (usually `nibfin`), and `run`. Use only public interfaces; never
   import Core or gh-nibfin source. Its context gives `ghNibfin(args)` (runs
   `gh nibfin` in the execution clone), `github`, `sandbox` names,
   `facts('nibfin')` (the command results, init PR numbers and digest) and
   `withExecutionVisibility('private', fn)` for scenarios that need a private
   execution repository; it restores public afterwards. `start`/`startGhNibfin`
   run long-lived children, `exec` runs one without secrets, `workDir()` and
   `browserEnv()` place and configure a browser, and `defer(fn)` registers a
   cleanup for the end of the scenario (each scenario has its own, also when it
   runs concurrently).
2. Import it in `scenarios/index.ts` and add it to the list `createScenarios`
   returns (a scenario that needs the host's processes takes the `HostServices`).
   The delivery-lifecycle scenarios are listed before that list in
   `src/registry.ts`, and the Dashboard and site scenarios after it, so the
   Dashboard scenarios run last. Registry order is run order. Set
   `concurrent: true` to let a scenario overlap its neighbours: each run of
   consecutive concurrent scenarios starts together and is awaited together, and
   every other scenario runs alone.
3. List its id under each of its rules in `coverage-map.json`.

Scenarios that run fixture Issues use the shared library in `scenarios/lib/`:

- `prepareFixture(kit, repo, {files, variables, ruleset})` (`fixture.ts`) is the
  first call of every fixture. It closes open Issues, waits on `podman events`
  for running Job containers to end, and requires both Runners online and idle;
  then it sets the library variables (`NIBFIN_MODEL`, `NIBFIN_CONTAINER_LIMITS`,
  `NIBFIN_MEMORY`) and deletes every `e2e-` ruleset; then it makes `main`'s tree
  the recorded baseline plus exactly `files` (fast-forward only); only then does
  it create the fixture ruleset. A scenario's result so never depends on what ran
  before it. The private peer has no rulesets (Proposal R3.55).
- Runners are identified by slot (`claude-1`, `claude-2`) with
  `runnerSlot(registrationName)` (`runners.ts`), never by a literal registration
  name: gh-nibfin names registrations `<hostname>-<hostid>-<slot>`. Runner
  checks always read the execution sandbox, where the Runners register.
- `watchJobContainers` (`containers.ts`) follows the Job containers of an Issue
  on `podman events` and keeps only an allowlisted projection of
  `podman container inspect`: the container environment holds the Nibfin token.
- `jobLog` (`joblog.ts`) downloads the stage Job's log to `.e2e-work/logs/`
  without sending the token to the redirect; `initEvents` reads the Claude CLI's
  `system`/`init` events from it.
- `e2e/probe.sh` (`probe.ts`) is committed by fixtures whose Skill text asks the
  agent to paste its output; it prints names, versions and booleans only.
- Every local wait is event-driven; the deadlines are in `waits.ts`. The only
  re-reads are for GitHub state no local event reports: the finish Job on a
  GitHub-hosted runner, a Job's log becoming available after its container
  ended, and a restarted Runner's registration showing online.

`npm run verify` fails when the map and the registry disagree.

### Host operations (Linux only)

The context also gives:

- `claudeLogin('valid' | 'invalid')`: writes the real token, or a random
  non-secret string, into the login volume on stdin and reads it back;
- `runnerServices('stop' | 'start')`: stops or starts each
  `nibfin-runner-claude-*` systemd user unit by name and reads it back;
- `stopJobContainers(repo, issue)`: stops one Issue's Job containers by
  Nibfin's Podman labels;
- `secretValues()`: the secrets, for in-memory absence checks only (never print
  them);
- `ownerLogin()` and `ownerId()`: the sandbox token's account.

`github.download(path)` downloads a job log; the redirect to the log storage is
followed without the token.

### Lifecycle fixtures (`scenarios/lifecycle/`)

- Fixture Issues are small: a few lines in their own `src/<slug>.js` with a
  `node:test` test. Titles start with `[e2e <scenario>]` and end with the run's
  tag, so fixtures of one run never collide.
- One shared observer reads the sandboxes at most once a minute. Every wait has
  a deadline and fails naming the last observed labels, runs and comment.
- Shared journeys (`journey()`, `holdJourney()`) drive one set of fixtures
  for several scenarios; each scenario reports its own rules.
- The template's CI and CD run `scripts/e2e-hook.js` with the rules in the
  `E2E_CI_RULES` / `E2E_CD_RULES` variables (`kit.hookRules`). A rule
  applies only when its `when` path is among the paths the triggering event
  changed, so **a rule's `when` path must belong to exactly one fixture**. Rules
  can require a file to mention a text, or hold the run until a tag exists
  (failing after 25 minutes).
- A scenario pauses its open fixtures in `finally`, so a failure does not keep
  spending Runner time.
- A rule whose triggering situation did not happen is reported `failed` as
  "not exercised", never `passed`.
