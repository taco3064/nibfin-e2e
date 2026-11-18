# Authorized operator investigation

The suite executable can investigate failures and publish confirmed code defects
using an explicitly authorized operator configuration. Full-run and per-phase
requests use the same composition after session settlement. Passing requests do
perform selected-provider readiness checks, but do not investigate, acquire
investigation source or obtain publication credentials.
`command(args, entries, investigation)` and `suiteCommand(args, investigation)`
remain available for controlled composition.

This adapter targets Linux. Choose `--agent codex` or `--agent claude` for every
opted-in suite request. There is no discovery, implicit default or fallback. This
choice affects investigation and assessment only, never the managed Runner Pool.
Codex requires a current installed executable supporting
finite filesystem permission profiles, ignored user configuration, ignored rules,
ephemeral execution and structured output. Unsupported versions fail closed.
Controlled executable/transport fixtures do not prove live host sandbox support,
operator authentication or GitHub workflow success. A host with `/etc/codex`
managed configuration is refused because its mandatory integrations cannot be
safely disabled here; this adapter never changes host policy. Live results need
verification in the
separately authorized operator environment. No Core executor, controller state,
Docker control or controller credential is used.

## Reusable setup

An operator must explicitly authorize public defect publication. Credentials merely
being present, including `GH_TOKEN` and `GITHUB_TOKEN`, never authorize this route.
Configure a private JSON file outside the repository and all scenario directories.
Set `NIBFIN_E2E_OPERATOR=authorized` and `NIBFIN_E2E_OPERATOR_CONFIG` to its absolute
canonical path. No CLI option, session file or report can select this configuration.
Non-suite commands ignore it.

For example, provision private directories under `/home/operator/e2e-private`
with mode `0700`; use mode `0600` for the configuration and credential file:

```json
{
  "version": 1,
  "authorization": "publish-public-defects",
  "configuration": {
    "targets": [{"repository": "owner/project", "id": 123}],
    "assignee": {"id": 456, "login": "operator"},
    "label": "scope"
  },
  "publicationMode": "issue-events",
  "codexExecutable": "/usr/local/bin/codex",
  "codexHome": "/home/operator/.codex",
  "credentialFile": "/home/operator/e2e-private/publication-token",
  "stateDir": "/home/operator/e2e-private/publication",
  "scratchRoot": "/home/operator/e2e-private/models",
  "suiteRoot": "/home/operator/e2e-private/suites",
  "evidence": [
    {"repository": "owner/project", "kind": "source", "path": "src/rule.mjs"},
    {"repository": "owner/project", "kind": "callers", "path": "src/caller.mjs"}
  ]
}
```

Use actual approved public repository names and numeric IDs. Each target requires
source and caller entries. These entries explicitly approve disclosure of those
public code files; they do not approve local files or diagnostics. Only supported
source extensions and finite public GitHub endpoints are available. The adapter
reads current default-branch source at an observed revision, verifies repository
identity and enumerates complete open and closed Issues. Oversized or incomplete
observations fail closed rather than truncate duplicate evidence.

Paths must be absolute, canonical, owned by the operator and private. The selected private
root directories must already exist and be disjoint from each other, the
configuration, publication credential and current repository. Their ancestors
must not permit replacement by other users. Scratch must be outside repository
and project configuration discovery. The executable must be a canonical installed
file, owned by root or the operator, executable and protected from replacement;
resolve installation symlinks when specifying it. No executable modules can be
loaded from configuration. Suite `--state-dir` must be a private child of
`suiteRoot`; create intermediate directories privately before use.

Use the operator's existing Codex login. `codexHome` and its `auth.json` must be
private. Each fresh invocation stages only that login into a private temporary
Codex home. It ignores user configuration and rules, disables repository
instructions, bundled skills, hooks, MCP servers and apps, and starts outside
repository configuration discovery. Host configuration and login files are not
modified. Reauthenticate through the normal Codex login if the existing login
cannot be reused. The child receives a clean environment. Its tools have finite
filesystem access to staged public evidence and disposable scratch, no network,
and explicit denials for authentication, publication credentials, journals and
scenario roots. No unrelated host home is granted to tools.

`credentialFile` is an explicitly authorized private credential capability,
provisioned by the operator's existing credential management. Do not put a token
in commands, reports, session configuration or repository files. This finite
adapter supports a user PAT (`ghp_` or `github_pat_`) and verifies `/user` against
the configured assignee before any authenticated repository request. It does not
read ambient GitHub credentials, invoke credential helpers or switch accounts.
The PAT needs permission to read the target and create Issues with the configured
assignee and pre-existing `scope` label. Actions `GITHUB_TOKEN` and installation
job tokens are unsupported: their Issue writes cannot supply the intended user
Issue event route. Model capability resolution and public evidence reads do not
require publication authentication; an absent publication credential cannot
produce a successful publication claim.

For Claude-only setup, replace `codexExecutable` and `codexHome` with
`claudeExecutable` (the canonical installed Claude Code executable) and
`claudeCredentialFile` (a private file containing an operator-provisioned
Anthropic API key). The unselected provider needs neither installation nor login.
Existing version-1 Codex configurations remain usable with explicit `--agent codex`.
The selected provider's authentication source must be disjoint from the publication
credential, configuration, private roots and repository. No arbitrary flags,
modules, settings or environment overrides are accepted in configuration.

Claude uses noninteractive bare print mode with a JSON schema. Each invocation
has a fresh private HOME/configuration, a scrubbed environment and API authentication
only in the trusted provider process. Built-in tools, allowed tools, MCP servers,
hooks, plugins, native Skills, browser integration, session persistence and
user/project settings are disabled. Approved public evidence is supplied in stdin;
Claude has no model tools for filesystem, shell or network access. Provider API
transport is separate from model tool access. The adapter refuses managed Claude
configuration under `/etc/claude-code`, `/etc/claude` or
`/usr/local/etc/claude-code`; it never bypasses mandatory host policy.

Before suite startup, bounded help compatibility checks and a small authenticated
structured readiness request validate only the selected provider. These do not
acquire investigation evidence or publication authentication. A passing suite
runs no subsequent investigation or assessment. A readiness request may incur a
provider API charge. Safe setup reasons are `OPERATOR_AGENT_REQUIRED`,
`OPERATOR_AGENT_UNSUPPORTED`, `OPERATOR_AGENT_UNCONFIGURED`,
`OPERATOR_AGENT_UNAVAILABLE`, `OPERATOR_AGENT_INCOMPATIBLE` and
`OPERATOR_AGENT_AUTHENTICATION`. Installation/configuration problems need operator
repair; authentication failures require normal provider authentication renewal.
Raw provider diagnostics and secrets are never copied into suite reports.

Run using the same configuration for subsequent requests:

```sh
export NIBFIN_E2E_OPERATOR=authorized
export NIBFIN_E2E_OPERATOR_CONFIG=/home/operator/e2e-private/operator.json
node e2e/cli.mjs --suite --agent codex --run-id demo \
  --state-dir /home/operator/e2e-private/suites/demo
# With the Claude fields provisioned in the trusted configuration:
node e2e/cli.mjs --suite --agent claude --run-id claude-demo \
  --state-dir /home/operator/e2e-private/suites/claude-demo
```

This suite still produces controlled lifecycle evidence. Investigation uses public
maintained code and a fresh independent assessment. Missing infrastructure,
rollout gaps and insufficient evidence cannot authorize a defect Issue. The
assessor independently reacquires approved source/callers and receives fresh
complete duplicates, verifies English content, disclosure safety, necessary code
change, semantic identity, existing Issue content and recurrence obligations.

## Completion and recovery

`issue-events` means publication is complete after exact Issue identity, content,
assignee, label and browser URL read-back. The result includes `route:
"issue-events"`, `wake: "not-requested"` and `issue.url` with the verified URL.
It makes no second dispatch and performs no Core run lookup. The existing Issue
workflow owns routing; its Actions result, admission and delivery are separate,
pending verification. Reused closed work stays closed and is reported as closed.
Legacy programmatic callers that omit the mode still require direct-wake
reconciliation; missing `wake` never silently selects event routing.

Preflight setup failures prevent suite execution and return failure themselves.
Later failures in acquisition, model output, assessment, credential identity,
metadata read-back or cleanup preserve the original test outcome and exit status.
Public results use bounded reason codes and never include raw private diagnostics.
An unavailable capability is not an implementation defect; pending or unknown
external effects are not successful publication.

Keep `stateDir` across invocations. The existing exclusive publication inventory,
semantic key, marker and durable create intent suppress duplicate and concurrent
creates. Unknown creates reconcile without repeating the write. Never delete an
unresolved lock based on age. Retain unknown ownership/effect records until
protected recovery proves settlement. Disposable model/authentication copies and
Scope source checkouts are removed only when their owning processes have stopped;
unknown process termination retains recovery material. Investigate and retire
that process before removing retained files. No extra publication journal exists.

Issue history is enumerated across open and closed Issues using the existing
paginated GitHub reader; pull requests are excluded. Investigation receives an
explicitly complete compact inventory (repository, identity, title and state),
not API metadata or a claim that titles establish duplicate absence. The existing
16,000-byte evidence-row and 512,000-byte model-input limits still apply.

Independent assessment reacquires source and callers, removes embedded proposal
evidence, and reviews every Issue's full title and body in sequential fresh
conversations. Each batch includes its surrounding input within 256,000 UTF-8
bytes. Absence requires successful assessments of every batch; unresolved batches
or contradictory duplicate identities prevent creation. The existing assessment
timeout covers the entire sequence. A single body that cannot fit fails safely.
Publisher reconciliation continues to use full authoritative records under its
existing lock, exact existing content, durable create intent and final read-back.

Recognized evidence failures retain safe code-owned reasons, including
`OPERATOR_EVIDENCE_LIMIT`, `OPERATOR_INPUT_LIMIT`, `OPERATOR_ASSESSMENT_LIMIT`,
`OPERATOR_ISSUES_INCOMPLETE` and `OPERATOR_ISSUE_CONTENT_UNAVAILABLE`. Unknown
exceptions expose only the existing generic failure reason. These failures never
establish successful publication or change the original suite exit status.
