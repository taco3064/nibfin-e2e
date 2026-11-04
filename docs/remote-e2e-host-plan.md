# Proposed temporary remote E2E host

Status: incomplete proposal under technical review, not an executable E2E host
approval. No Runner registration, credential provisioning or authenticated
Agent execution has occurred. The two prerequisites below remain unresolved.

## Requested boundary

- Owner confirmed that no existing remote VM is available and requested a
  minimum resource proposal. The former GitHub-hosted 360-minute VM idea does
  not satisfy private journal retention on host loss and is superseded here.
- Propose one DigitalOcean Basic Regular x86-64 VM: Ubuntu 24.04, 4 vCPU,
  8 GiB RAM and its included 160 GiB boot disk, for at most 24 hours of evaluation
  and delivery. The existing Agent container limit is 4 GiB and 2 CPUs; 8 GiB
  is proposed headroom for the Runner, Docker and bounded Hooks without changing
  limits. Actual capacity is unverified; this is not a proven minimum.
- Add one independent 10 GiB private block volume in the same datacenter for
  Core's existing state, workspace and journal. Use a fixed mounted ext4 path,
  controller ownership and 0700 permissions; Agent mounts remain restricted.
  Never fall back to a boot-disk directory if the volume is missing.
- No Kubernetes, GPU, domain, load balancer, paid backup plan, additional VM or
  shared infrastructure. Region availability and actual quote require read-back
  before purchase; no cloud account or paid resource has been created.
- One explicitly registered repository-level Self-hosted Runner. Repository
  registration and an Owner routing label do not restrict which workflow can
  execute on it. Native registration/job/OIDC must be verified; being inside a
  hosted VM does not establish Self-hosted identity.
- One original work item: Scope Issue #2. No extra prerequisite Issues,
  replacement scheduler, shared Runner pool or persistent control service.
- Administrator-owned verified Core installation and policies; a dedicated
  non-root controller/Runner account, private state and the existing rootless
  Docker backend. The Agent never receives the Docker socket or host privileges.

This is one optional remote verification configuration, not a new product
host-OS requirement. It does not require changes to Windows or WSL.

## Proposed cost and lifetime

Official prices checked on 2026-11-04: the selected VM is USD 0.07143/hour
(USD 48/month); block storage is USD 0.10/GiB/month, charged hourly even when
detached. Estimate about USD 1.75 for 24 hours including the 10 GiB volume,
before tax and any separately charged usage. Retaining only that volume costs
at most USD 1 per month at the quoted rate.

Request a USD 3 pre-tax resource budget: at most 24 VM hours and at most one
month of volume retention. This is an authorization limit, not a claim that
the provider supplies a hard spending cap. Do not extend VM time, resize or
add paid resources without Owner approval. If the account requires a deposit,
minimum payment or a different quote, report it before purchase.

Stopping a VM is not retirement or a billing guarantee. At the deadline, stop
execution, reconcile what is known, retire the Runner and destroy only the VM
after checking for required recovery data. Preserve the independent volume if
effects remain unresolved. Never include it in automatic VM deletion. Report
any inability to perform retirement promptly; do not silently exceed the budget.

If Pending remains unresolved, escalate before the volume-retention deadline
for an explicit extension or a reviewed migration of minimum private recovery
evidence to an authorized durable destination. Neither automatic journal
deletion nor indefinite unapproved storage billing is permitted. Reaching a
cost/time limit does not establish that an external effect did not occur.

## Sources and native authority

Use exact reviewed Core commit `f0db1b5c678461b759ba5f4d8b2100822dd98960` and the
compatible reviewed Action/CLI producer pins. Verify the actual source package,
manifest, runtime, Skills and container image identities before adoption.

Scope Issue #2 is bound by approval PR #4 to its original body and Owner role
memberships, with distinct execution/session identities still mandatory. The
record expires at `2026-11-07T07:07:31.692Z`. Fresh native approval, protection,
ruleset, permissions, Scope, dependencies and Caller checks remain necessary.
Expiry or source changes require reconciliation; the record is not auto-extended.

The actual approval suite is `4897342201`, with before/after SHAs, Owner actor
and active passing classic/ruleset evaluations. Current protection remains
classic plus exact adopted repository ruleset `26512964`, with no bypass,
zero human Required Approvals and strict app-bound `verify`.

## Private identity provisioning

Privileged identity provisioning needs separate Owner authorization. Propose
a new dedicated Codex ChatGPT login session through a private supported flow,
preserving the existing login. Provision only through the provider's private
console or authenticated encrypted SSH after independently confirming host
identity. A public workflow, branch or PR must not obtain bootstrap identities.
No per-stage human approval or second GitHub human account is introduced.

Keep the existing workstation GitHub administrator credential local. Use it
only for authorized native Runner registration/retirement; transfer only the
short-lived registration material over the verified private channel. The
separate, repository-scoped controller credential needs
administration read plus the approved stage writes; only bootstrap management
needs Runner administration write. Hosted locators use a separate read-only
identity. Do not silently reuse a write credential as a hosted read token.

The Owner must approve this channel and the dedicated session's remote use.
Do not publish login links/codes, auth files, refresh tokens or credentials in
Actions logs, artifacts, Issues, source files or chat.

The GitHub controller credential must be limited to this test repository and
the actually required native administration/Actions/Contents/Issues/PR access.
Do not export the existing broadly scoped workstation credential. Store only
private file references in fixed host adoption; no request can select tokens,
executables, sockets, policies or adapters. Agents and Hooks receive neither
the controller credential nor another role's private state.

All external fork contributors require workflow-run approval. Keep CI hosted
and read-only. A routing label is not authorization. Never approve an untrusted
fork workflow merely to exercise a negative test.

## Prerequisites found in independent review

### Admission before workflow steps

Environment-secret protection and Core admission do not prevent an arbitrary
workflow shell from running before Core. Personal repository registration must
not be treated as an organization Runner-group workflow allowlist.

Investigate a fixed administrator-owned pre-job hook outside the Runner
installation. GitHub documents that a nonzero pre-job hook exit blocks the job
and cannot be overridden with `continue-on-error`. Reuse Core's native identity
checks instead of implementing another authorization policy. The real Runner
must prove availability of the required job/OIDC identity at that point and
rejection before any workflow step, container action or untrusted code runs.
This mechanism is a candidate, not verified protection.

Any initial remote safety evaluation must have no model authentication, no
controller write credential and no permission to execute Issue #2. Its bounded
registration credential must be unavailable to test jobs. Review the fixed
evaluation implementation before requesting its execution authorization.

### Journal survival after host loss

The existing private OperationJournal must survive cancellation and host loss
before an effect-bearing delivery can run. A final cleanup step or post-job
hook is insufficient: abrupt cancellation and VM destruction can prevent it.
Public repository artifacts are not an approved private journal destination.

The proposed independent block volume retains the existing journal without a
second delivery database. It is not yet provisioned or verified. Before any
effect-bearing stage, test private permissions, Core directory/file sync and
recovery after a controlled VM interruption using probe state, not a real
unknown write. Prove that missing/wrong/unmounted storage denies startup, and
that cancellation leaves the existing exclusion/Pending evidence available.
Do not reset a fence or replay an uncertain operation merely because the volume
can be reattached. No artifact checkpoint service or new controller is proposed.

Do not place Agent credentials or execute effect-bearing stages until both
prerequisites pass. A lost host must remain unresolved; no automatic replacement
or clean-state retry may erase that uncertainty.

## Verification and execution order

1. Review the fixed provisioning implementation before running it. Do not start
   private identity provisioning from a public unreviewed branch or PR workflow.
2. Verify rootless Docker, preloaded fixed AppArmor/seccomp, controller ownership,
   image identity, credential/workspace separation, restricted egress, process
   limits and cleanup on that exact VM. No security control may be disabled.
3. Register and read back the single Runner only after host capability checks.
   Adopt its actual IDs, full job names, fixed caller sources and signed OIDC.
4. Verify the legitimate protected entry and actual authenticated Agent adapter.
   A sandbox probe or successful login alone is not a Shape/Validator result.
5. Start the single lawful Dispatch and let existing Core continuation perform
   Shape, independent Validator, publication, delivery, Hooks, independent Accept,
   PR/current CI, final review, protected merge and closure. Do not manually
   manufacture stage outputs, labels, receipts or phase-by-phase handoffs.
6. Read back native Runs/Jobs, receipt/source identities, Candidate, current CI,
   review, merge and Closed + delivered. No Release or Bootstrap closure follows
   automatically; those require the separate Owner decision.

## Termination and cleanup

An expired VM/job budget is not proof of successful delivery or of no unknown
external effects. Preserve Pending after uncertain writes/processes; never
automatically re-register a replacement Runner or retry from a clean VM.

Before normal retirement, stop the Runner/Worker and prove Agent/Hook processes
and containers absent. Then remove its native registration and read back that
it is gone, retire only newly provisioned credentials/secrets, and remove the
private temporary state. Preserve the existing login and user-owned resources.

If an effect is unresolved, retain only the minimum private reconciliation
evidence and report the exact native identities. Do not upload authentication
files or discard a pending journal merely to finish cleanup. Reconcile native
writes before any authorized replacement or retry. No permanent evidence
database or alternate delivery state machine is introduced.

## Approval still needed

First resolve and review the concrete admission and private persistence plan.
Then Owner approval must cover its actual remote resource, Runner setup and
private dedicated GitHub/Codex identity-provisioning channel. Repository/Issue
approval alone does not grant those privileges. Approval of this document
cannot substitute for the missing technical verification.

The proposed authorization is limited to the VM/volume and USD 3 pre-tax budget
above, one test-repository Runner, private repository-scoped identities, and a
new dedicated Codex session. First perform safety-only evaluation with no
effect-bearing stage or Agent credential; continue to authenticated Issue #2
only if the reviewed admission, persistence and isolation checks pass. Failed
checks require diagnosis and no reduced protection. No automatic retry follows
unknown external effects. Cloud account/payment login may require the Owner;
no credential should be pasted in chat.

References: [Core host adoption](https://github.com/taco3064/nibfin-core/blob/f0db1b5c678461b759ba5f4d8b2100822dd98960/docs/host-launcher.md),
[GitHub environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[GitHub pre-job hooks](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts),
[VM pricing](https://www.digitalocean.com/pricing/droplets),
[volume pricing](https://docs.digitalocean.com/products/volumes/details/pricing/),
[independent volume lifecycle](https://docs.digitalocean.com/products/droplets/how-to/destroy/),
[official Codex headless authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).
