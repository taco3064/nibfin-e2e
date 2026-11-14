# Isolation selections

`isolation.local` exercises Core's prepared current-main Runner fixture, binding
reader, generated role plans, Docker endpoint/socket validation and network-policy
functions. Its observations are synthetic contracts, not OS enforcement. No socket
is opened, protected path read, cross-role write attempted or network probe sent.
The synthetic socket host is an in-memory observation, not an incidental host path.

`isolation.host` exposes host-path, credential, role-write and network selections.
Workers intentionally have no protected sandbox executor. On Linux these checks
are blocked pending authorized protected-runner probes. Other OS behavior is
unverified. Missing prepared Core blocks either selection. A source checkout,
worker claim or denied-looking exception cannot establish host enforcement.
Core's maintained sandbox preflight and managed probe construction remain with
the protected runner; these scenarios do not invoke Docker or install a host
adapter. No host isolation coverage is claimed by this implementation.

Result messages identify the actual OS, Node runtime, observed source identities
and execution mode. Imported local failures use a fixed diagnostic instead of
provider exceptions. The existing executor owns temporary directories, termination
and cleanup; cleanup failure overrides success. No scenario creates a detached
process, credential sentinel or resource outside that owned surface.

Run `npm --ignore-scripts run verify` for local regression checks. Real Core
contract execution requires the existing prepared source context and can be
selected with `npm run e2e -- --group isolation.local`. Host selections remain
visible with `--group isolation.host` and return non-success while unavailable.
