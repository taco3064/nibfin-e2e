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
| `nibfin` | In a clone of the execution sandbox: `gh nibfin runner add claude --count 2`, `init` on execution then peer; reads the image digest from the init PR and rebase-merges both init PRs |

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
runner registration and ruleset. It closes open pull requests and resets the merge
and pull request settings and the visibility. Collaborators are not touched.

**Only one host at a time may use the sandboxes.** A matrix of hosts must run its
legs one after another (`strategy.max-parallel: 1`). The online-runner check
catches only some overlaps; it does not make concurrent hosts safe.

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
   execution repository; it restores public afterwards.
2. Import it in `src/registry.ts` and add it to `scenarios`.
3. List its id under each of its rules in `coverage-map.json`.

`npm run verify` fails when the map and the registry disagree.
