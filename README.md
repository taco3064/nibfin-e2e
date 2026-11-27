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

`--plan <path>` runs the selection of a gate plan (below) instead of
`--all`/`--rule`/`--section`. A scenario whose selected rules are all waiting is
reported `waiting` and not run. A step or scenario held back by a required step
names it in `blockedBy`, and `meta.runner` records `RUNNER_NAME`.

`--budget-minutes <n>` (default 220, below the 240-minute job timeout) bounds a
run from the harness's start. Provisioning and scenarios stop 30 minutes before
it: the step or scenarios in progress fail with `harness budget of N min ran out
during this step` (or `scenario`), get 2 minutes to unwind, and later ones are
`failed` with `not run: …`. Teardown then runs until the budget ends; a teardown
step it cuts off fails. The result is always written, so `report` can file
requests with the rules. A lifecycle wait also fails as soon as the sandboxes
show its goal is out of reach (`gave up waiting for …`), and after 20 minutes
without sandbox activity (`no sandbox activity for N min while waiting for …`).

## Gate

`npm run gate -- <subcommand>` decides what to rerun and files `request` Issues
in this repository for what the Scope stage or a person must judge. No agent
runs in it and it never reads the Proposal. Each subcommand prints one JSON
document to stdout (with a Markdown `summary` for `$GITHUB_STEP_SUMMARY`) and
writes no file.

- `select --delivered <owner/repo>#<n>` (nibfin-core, gh-nibfin or nibfin-e2e), `select --rule …
  --section …` or `select --all`: prints the plan. A delivered Issue selects the
  ids of its approved Shape's `Proposal rules:` line; a Shape without the line,
  with a malformed line, or no single Shape falls back to the `R` ids, ranges and
  `§` sections under the Issue's `## Authority`, and the decisions say so. A
  nibfin-e2e Issue also selects from the files its merged PRs (branches
  `nibfin/issue-<n>` and `nibfin/issue-<n>-cd-<k>`) changed: a `scenarios/**`
  file selects the rules of the scenarios defined in it or in a file importing
  it; `src/**` outside `src/gate/`, or `sandbox-template/**`, selects every rule;
  docs, tests, gate code and configuration select nothing. An
  Issue not closed with `delivered` selects nothing. A rule cited by an open
  `scope` Issue in nibfin-core or gh-nibfin is `waiting`. Selected rules without a
  scenario are `gaps`; other uncovered rules (every one in `--all`) are
  `unselectedGaps` and only listed.
- `report --plan <path> --results <dir>`: reads every `*.json` result under
  `<dir>` (validated against the registry and the map; anything else counts as no
  result) and the run's jobs, then files one request per root failure
  (`Scenario failed: <id>`, `Provisioning failed: <step>`, `Teardown failed:
  <step>`, merged across legs), per failed, cancelled or timed-out job without a
  result (`Job failed: <job>`) and per plan gap (`Coverage gap: <rule>`).
- `report --leg --results <dir>`: the final step of one `run` leg, so that
  leg's failures are filed when it ends instead of after the other leg. It needs
  `RUNNER_NAME` and takes no `--plan`. It files the root failures of the leg's
  results with the same titles, or, when the leg has no usable result,
  `Job failed: <job>` for its own job (found by `RUNNER_NAME`, still in
  progress) with the steps that failed so far. Other jobs, plan gaps and the
  coverage check are left to the final `report`, which still runs after both
  legs and files whatever the legs did not (a leg whose step did not run or
  crashed, a job that never reached it). It exits `1` only for the leg's own
  failures or a failed filing.
- `proposal-updated`: reads the `repository_dispatch` event (`client_payload`:
  `page_id`, `block_ids`, ISO-8601 `timestamp`) and creates or comments on the
  open request titled `Proposal updated`, whose body keeps the earliest and latest
  event times and the previous handled update's time.

Every request is created with `NIBFIN_GITHUB_TOKEN` (so it wakes Nibfin),
labelled `request`, assigned to the token's account and read back. An open
request with the same title is reused with one comment per run; a hidden
`<!-- nibfin-e2e:run <id> -->` marker makes a re-run attempt skip what it already
wrote. A failure built from leg results also carries one
`<!-- nibfin-e2e:run <id> leg <platform> -->` marker per leg it contains, so the
same title from a second leg (or the final report) adds one comment with only
the legs not yet filed. Before filing, `report` also reads this run's Issues
in every state (updated since the run started, with its run marker in the body
or a comment): a request a leg filed and Scope closed meanwhile counts as
already filed, and a leg not yet filed under a closed request goes on a new one.
`report` and `proposal-updated` need `GITHUB_RUN_ID`, `GITHUB_SERVER_URL`
and `GITHUB_REPOSITORY` (`taco3064/nibfin-e2e`); `proposal-updated` also needs
`GITHUB_EVENT_PATH`.

Exit codes: `2` usage or input error (no write), `1` a failure was found, a
selected rule has a coverage gap, a write or read-back failed, the plan is missing
or unusable, or the whole-map coverage check failed in an `--all` run, `0`
otherwise. In other runs (`--delivered`, `--rule`, `--section`) unselected gaps
are only listed, and the coverage check row notes that it does not fail the run. The harness
never reads `NIBFIN_GITHUB_TOKEN` and drops it from every child's environment.

## Host provisioning

Execution runs on a fresh GitHub-hosted runner (`ubuntu-24.04` or
`windows-2025`) with Git, Go, Node and `gh` installed. e2e does not verify
macOS (Proposal R8.24); macOS support is checked by hand outside e2e (R6.30).
The steps run only when a selected scenario `requires` them (directly or
through another step), in this order:

| Step | What it does |
|---|---|
| `gh-nibfin` | Clones gh-nibfin at `--gh-nibfin-commit`, builds `dashboard/` then the binary, and installs it with `gh extension install .` |
| `podman` | Linux: checks Podman. Windows: installs the pinned Podman MSI (sha256 checked) and runs `podman machine init`; `runner add` starts the machine |
| `claude-login` | Writes the Claude token into `env` of `settings.json` in the `nibfin-home-claude` volume, keeping every other key |
| `sandboxes` | Refuses to start while a runner registration is online on the execution sandbox, then resets both sandboxes and reads them back |
| `nibfin` | In a clone of the execution sandbox: records the host state (`hostBefore`; on Windows it first adds a `[wsl2]` section with the default `nestedVirtualization=true` when `.wslconfig` has none), then `gh nibfin runner add claude --count 2`, `init` on execution then peer; reads the image digest from the init PR, rebase-merges both init PRs and records each sandbox's `main` head and tree as its baseline |
| `observed-job` | Runs one agent fixture on the execution sandbox through Shape, Deliver and Review and records what its Jobs ran with (container projection, probe output, log facts, login volume facts, the pushed branch, how the PR ended) for the scenarios that read it |
| `collaborator` | Linux only. Checks that the second account is a write (not admin) collaborator on the execution sandbox; creates the OS user `e2epeer` (subordinate ids, linger and its user manager); installs the built gh-nibfin for it; clones the execution sandbox into its home; writes its `nibfin-home-claude` volume; generates an ed25519 key as `e2epeer` and adds the public half to the second account as `nibfin-e2e-peer-<time>` |

Whatever the selection, the last collaborator scenario a run starts then retires
the collaborator: its `runner remove` and the deletion of its registrations on
the execution sandbox (setup, as the Owner would in Settings), so the later
Dashboard scenarios count only the Owner's Runners; a retirement that leaves
something fails that scenario.

After the scenarios, teardown runs for every step that ran, in reverse order:
the collaborator's `runner remove` and the deletion of every
`nibfin-e2e-peer-*` SSH key from the second account (read back), the Owner's
`runner remove` (skipped when `status --json` lists no claude Runner, as after
the `runner-remove` scenario), then a second reset of both sandboxes, read back
to show nothing is left. It needs these environment variables:

- `E2E_SANDBOX_TOKEN`: fine-grained token for both sandboxes. The harness sends it
  only in its own GitHub API calls and as `GH_TOKEN` to `gh`.
- `E2E_CLAUDE_TOKEN`: the output of `claude setup-token`. It reaches the login
  volumes (the Owner's and `e2epeer`'s) only through a helper container's stdin.
- `E2E_PEER_GITHUB_TOKEN`: classic token (`repo`, `admin:public_key`) of the
  second GitHub account, a write collaborator on the execution sandbox. The
  harness sends it only in its own `/user` and `/user/keys` calls, in its own
  calls submitting the `review-events` PR reviews on the execution sandbox, and
  as `GH_TOKEN` to `e2epeer`'s `gh`, on the first stdin line of the `sudo`
  wrapper, never as an argument. Only the collaborator scenarios and
  `review-events` need it.

Commands as `e2epeer` run through `sudo -u e2epeer -H` (passwordless on hosted
Linux runners), so they get none of the harness's environment. The harness reads
only public key files and file modes in `e2epeer`'s home, never a private key.

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
   import Core or gh-nibfin source. Its context gives:
   - `ghNibfin(args, {input, env})`: runs `gh nibfin` in the execution clone;
     `startGhNibfin(args, {path})` and `start(argv)` run long-lived children
     (for example the Dashboard) with `waitFor` and `stop`;
   - `gh(args, {env})` (with the sandbox token) and `exec(argv, {input, cwd,
     env})` (no token) for other host commands. `env` adds variables after the
     credential filter and refuses `GH_TOKEN` and `E2E_*`;
   - `github`, `sandbox` names, `workDir()` and `workPath(...)` (under
     `.e2e-work/`; the gh-nibfin clone is `workPath('gh-nibfin')`),
     `browserEnv()` for a browser, and `claudeSettings()` (the login volume's
     settings.json, compared in memory only);
   - `facts('nibfin')`: the command results, init PR numbers, image digest and
     `hostBefore`, the host state read just before `runner add` (Linux: user
     unit files, linger and `/etc/systemd/system`; without a running user
     manager the units are the globally enabled ones plus the user's own
     `.wants`/`.requires` entries; Windows: `.wslconfig` and the scheduled
     tasks), so a scenario can see what the setup changed;
   - `withExecutionVisibility('private', fn)` for scenarios that need a
     private execution repository; it restores public afterwards;
   - the host operations below (Linux only);
   - `upcoming()`, which lists the scenarios the run still starts after this
     one;
   - `peer()`, the collaborator (requires `collaborator`): its login and id,
     this run's SSH key id, `ghNibfin(args)` in its clone, `run`, `stat`,
     `list`, `readPublic`, `units` and its own `github` client;
   - `defer(fn)`, which registers a cleanup for the end of the scenario (each
     scenario has its own, also when it runs concurrently).

   `scenarios/lib/` holds the shared helpers. The management scenarios use
   `Check` (collects every mismatch by rule, hides tokens and the Dashboard
   proof), `waitFor` (bounded polling within the run), `readWorkflow`
   (line-based workflow reads), `statusValidator` (gh-nibfin's
   `schema/status.schema.json`, draft 2020-12, strict),
   `mainDigest`/`requireCurrentImage` (anonymous GHCR `:main`), the hold
   fixture (a plain `self-hosted` workflow that keeps one Runner busy) and
   `--help` and read-back parsing.
2. Import it in `scenarios/index.ts` and add it to the list `createScenarios`
   returns (a scenario that needs the host's processes takes the `HostServices`),
   or list it directly in `src/registry.ts`, as the installation and management,
   delivery-lifecycle, Dashboard and site scenarios are. Registry order is run
   order. Set `concurrent: true` to let a scenario overlap its neighbours: each
   run of consecutive concurrent scenarios starts together and is awaited
   together, and every other scenario runs alone.
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

### Run order

The installation and management scenarios (`scenarios/management/`) run
first, on the fresh host and the init PRs; `upgrade` runs before the
delivery-lifecycle scenarios so GHCR's main image has little time to move after
`init`. `runner-always-on` follows `host-requirements`, `runner-location` and `runner-no-periodic` and adds a 5-minute idle
wait with no command running (Proposal R5.11). Their fixture Issues are left paused or without `scope`, and the
lifecycle scenarios judge only their own tagged fixtures and the runs created
since they started. Then come the Issue #299 and site scenarios, then the
Dashboard scenarios. `runner-add-login` runs alone after them: it starts a Codex
login through `runner add codex`, abandons it at the guide (Proposal R5.30) and
removes what the attempt created. `runner-remove` comes last because it removes every
local Runner and the login volume.

## Proposal relay

`relay/` is a small Cloudflare Worker, Nibfin's own project setup rather than a
product component (Proposal R8.13). It turns Notion webhook events for the
Proposal page into a `repository_dispatch` of type `proposal-updated` on this
repository. Its `client_payload` carries `event_id`, `type`, `timestamp`,
`page_id`, `attempt_number`, `block_ids` (the changed block ids, which the gate
reads) and `updated_properties` (both id
lists are emptied and `ids_omitted: true` is set when they would exceed
GitHub's payload limit). It carries no content and holds no Notion API token: the
diff is read later from the page's version history using the event times.

- Every event must carry a valid `X-Notion-Signature` (HMAC-SHA256 of the raw
  body keyed with the verification token); anything else gets 401.
- Only `page.content_updated` and `page.properties_updated` for the configured
  page are forwarded; other signed events get 200 and are dropped.
- A failed dispatch gets 502, so Notion redelivers on its own backoff.
- Persistent Workers Logs are disabled. The log has fixed reason codes only, and
  never a token, a signature or a request body, except for the bootstrap line
  below.

Its unit tests run with `npm run verify`. Deploying is manual (Owner only):

1. `npx wrangler@4.168.0 deploy --config relay/wrangler.jsonc`
2. Start `npx wrangler@4.168.0 tail --config relay/wrangler.jsonc` and keep it
   running. The tail only streams live and keeps nothing, so it must already be
   running when Notion sends the token.
3. In Notion, create a webhook subscription to the `workers.dev` URL, selecting
   the page content and page property update events. Notion sends the
   verification token once, at creation. While `NOTION_VERIFICATION_TOKEN` is
   unset, the Worker logs it in the running tail once, as
   `verification_token: …`. If the tail was not running, click "Resend token"
   in Notion while it runs and the secret is still unset.
4. `npx wrangler@4.168.0 secret put NOTION_VERIFICATION_TOKEN --config relay/wrangler.jsonc`
   with that token, then paste it into Notion's verification form.
5. `npx wrangler@4.168.0 secret put GITHUB_TOKEN --config relay/wrangler.jsonc`
   with a fine-grained token for this repository only, with Contents: write
   (the minimum `repository_dispatch` accepts).

Once the secret is set, a resent verification token is rejected and not logged.
To verify again or recreate the subscription, first run
`npx wrangler@4.168.0 secret delete NOTION_VERIFICATION_TOKEN --config relay/wrangler.jsonc`.
