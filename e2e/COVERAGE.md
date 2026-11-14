# Behavior coverage library

`coverage-catalog.mjs` maintains intended behaviors for current main of Core,
Action and CLI. Its production mappings remain empty. The registered Issue-wake
and Action contract fixtures do not establish live behavior coverage.
Extend entries with `{ id, product, category, scenarioIds }`.
Products are exactly `Core`, `Action`, `CLI`; IDs and categories use lowercase
identifier segments separated by dots or hyphens. Unregistered mappings are
allowed and remain unverified. Duplicate behavior IDs or mappings are errors.
This catalog is an implementation input, not a new requirements authority.

```js
import { calculateCoverage, exportCoverage } from './coverage.mjs';
import { summarizeCoverage } from './coverage-summary.mjs';

const coverage = calculateCoverage({
  // Omit catalog and registry to use the maintained production inputs.
  runs: [{
    document: { schemaVersion: 1, results: [], errors: [] },
    environment: 'linux',
    provenance: 'local-test',
    evidence: [],
  }],
});
const json = exportCoverage(coverage);
const markdown = summarizeCoverage(coverage);
```

These are ephemeral strings for callers to use as artifacts or summaries.
The library does no network access, execution, persistence or publication.

## Inputs and associations

Each run consumes an unchanged version-1 runner document. Registered metadata
is validated through the runner registry. Results must be unique, match a
registered scenario and its group, and use the runner's authoritative outcomes.
Reason code/message and runner error strings are retained in structured output.
Malformed documents, unknown results and ambiguous duplicate results throw
explicit errors. They cannot manufacture coverage. Errors do not erase valid
individual observations, but always prevent `complete` from being true.

`environment` is an explicit nonempty label or null (unknown). `provenance` is
`unknown` by default, `local-test` for synthetic evidence, or
`native-observation` for caller-supplied native observations. Neither provenance
nor a URL authenticates input or asserts a release, installation or delivery.
Run records must have distinct environment labels (including null). Do not
merge multiple documents for one environment without resolving their meaning
outside this API. Separate environments have separate totals; no cross-run
union or success total is produced.

Evidence entries are `{ scenarioId, urls, exercised? }`, associated with one
observed scenario in that run. Duplicate scenario associations throw even when
identical. The same URL can legitimately support distinct scenarios or
behaviors without changing the behavior denominator. Repeated URLs within an
association are deduplicated. URLs never establish exercise or passing status.
Rejected URL text is discarded, with only a rejected count retained.

Only HTTPS github.com native issue, PR, run, job and commit paths and equivalent
api.github.com resource paths are accepted. Credentials, nonstandard ports,
query strings, fragments and unsafe characters are rejected. URLs are never
fetched. Summaries encode label punctuation and omit raw diagnostic messages;
structured error/reason messages remain untrusted data and must not be rendered
as markup by consumers. The summary renderer validates evidence URLs again.

## Calculation and output

Every catalogued behavior is in the denominator in every environment, even if
unmapped, unregistered, unselected or excluded by policy. Empty populations have
null percentages, never 100%. A behavior passes only if it has at least one
mapping and every required mapped scenario passed in that environment.
Otherwise its outcome uses this precedence: failing, blocked, unverified,
skipped-by-policy. Missing results are unverified. Per-scenario rows preserve
all source outcomes and reasons, including policy exclusions even when another
scenario determines the combined outcome. `failing` retains the runner meaning.

A passed result establishes exercise. Other runner outcomes alone cannot prove
exercise: failures may precede execution and unverified includes unimplemented
scenarios. Explicit `exercised: true` context can record known execution without
promoting its outcome. Blocked and policy-skipped results reject that claim.
Behavior exercise requires every mapped scenario to have exercise evidence.
Registration, observed results and exercise remain separate scenario fields.

Each environment exposes behavior totals, product/category breakdowns, outcome
counts, scenario rows and mapped evidence. `complete` means a nonempty catalog
with all behaviors passing and no runner errors; it is not live certification.
`productionPassing` excludes local-test and unknown provenance, and requires an
explicit environment. It is still only caller-supplied observed passing coverage,
not proof of production delivery. Callers must label synthetic evidence with
local-test provenance. Registered `wake.*.fixture` scenarios remain unmapped
from the production catalog; their success cannot certify a live route.

Run `npm --ignore-scripts run verify` for syntax, complete-file source limits
and local unit tests. These checks establish local implementation evidence only.
