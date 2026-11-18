# Ordinary group source selection

By default each required producer is acquired from its official `main` branch.
To run a historical regression, select public revisions before preparation:

```sh
node e2e/cli.mjs --group cli-onboarding \
  --source core=e8c16453218c4d5537ef0808540a31d44e628573 \
  --source action=refs/tags/v1.0.0 --source cli=refs/heads/regression
```

The tag and branch above are syntax examples, not a verified compatible set.
Repeat `--group` and `--source` as needed. Each producer ID (`core`, `action`,
`cli`) may appear once. Revisions are `main`, a full lowercase 40-character
commit ID, or an explicit `refs/heads/NAME` or `refs/tags/NAME`. Names use ASCII
letters, digits, dots, underscores, hyphens and slash-separated components;
they start with a letter or digit and cannot contain empty components, `..`,
components starting or ending with a dot, or components ending in `.lock`.
Abbreviated commits, revision expressions, URLs, paths and executable arguments
are unsupported. Library callers use `sourceOptions.selection: { core: revision }`
with the same validation. Unspecified producers retain `main`.

Selections never expand a group's source requirements. Acquisition fetches each
required producer once from its fixed official repository, resolves a commit,
and checks it out before preparation. Unavailable revisions fail without a
fallback. Core's local `main` is bound to that acquired commit; consumer
checkouts are detached. Existing exact consumer declarations remain authoritative:
incompatible default or supplied sources produce `SOURCE_PREPARATION_ERROR` and
prevent affected scenarios from running. Independent scenarios can still run.

The ordinary JSON document adds a `sources` array with `id`, `repository`,
`revision` (the selection, defaulting to `main`) and `commit` (the observed commit).
Only acquired sources appear, including checkout-only dependencies. Identities
remain available after preparation or compatibility rejection. Checkout paths
and declarations are excluded from this summary. Diagnostics remain on stderr.
Temporary owned sources are removed after settled execution; unknown process
termination retains the existing recovery behavior.

Historical regression results describe those selected sources and controlled
scenarios. They do not establish protected delivery, deployment or release
readiness, and ordinary source arguments do not select protected suite operations.
