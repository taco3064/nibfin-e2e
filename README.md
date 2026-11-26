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
npm run e2e -- --rule R5.13 --rule R5.14 --section 3 \
  --gh-nibfin-commit <40-hex sha> --image ghcr.io/<owner>/<image>@sha256:<digest>

# Run everything (pre-release); adds a gate that needs 100% coverage
npm run e2e -- --all --gh-nibfin-commit <sha> --image <ref>@sha256:<digest>
```

Only scenarios for the current platform run. Each provisioning step and scenario
reports `passed`, `failed` or `waiting` (the Proposal is ahead of the
implementation) with a reason.

Exit codes: `2` usage or validation error, `1` a scenario failed or the `--all`
gate did not pass, `0` otherwise.

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
   `requires`, and `run`. Use only public interfaces; never import Core or
   gh-nibfin source.
2. Import it in `src/registry.ts` and add it to `scenarios`.
3. List its id under each of its rules in `coverage-map.json`.

`npm run verify` fails when the map and the registry disagree.
