# Project configuration local contract

Select with `npm run e2e -- --group project-configuration`. The normal entry
retains current-main source preparation and producer compatibility checks.
`project-configuration.local` imports maintained Core implementations; missing
sources block execution, and failed assertions cannot produce a passing result.

The fixture creates target, dispatcher and synthetic role state directories under
the worker's disposable workspace. It observes target Job selection, immutable
per-Job tools/domains, environment consumers and actual role-agent staging and
planning. All five execution roles are checked with default, extend and override
instructions. Target edits are reread at subsequent startup, while dispatcher and
comparison-main decoys are ignored. Invalid configuration and Skill paths,
unreadable files, and malformed override results are negative controls.

Synthetic adapters inspect staged files and Core plans without launching an
Agent, a container, a tool installer or network traffic. Synthetic authentication
has no authority. These observations do not verify host tool installation,
authenticated Jobs, proxy enforcement or live network access. Permission denial
requires a process without DAC override; if mode-zero files remain readable, the
negative control fails explicitly rather than claiming unreadability was tested.

The worker launches no child processes or services. The existing executor confirms
worker termination before deleting its workspace; failed cleanup or unconfirmed
termination prevents success. Imported diagnostics are sanitized to a fixed error.
