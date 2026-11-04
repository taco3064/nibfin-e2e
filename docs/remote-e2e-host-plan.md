# Proposed temporary remote E2E host

Status: proposed configuration for Owner review. No Runner registration,
credential provisioning or authenticated Agent execution has occurred.

## Requested boundary

- One temporary GitHub-hosted Ubuntu 24.04 VM, kept alive by one fixed bootstrap
  job for at most 360 minutes. No new paid VM or cloud-provider account.
- One explicitly registered Self-hosted Runner, restricted to this repository
  and the Owner member route. Native registration/job/OIDC must be verified;
  being inside a hosted VM does not establish Self-hosted identity.
- One original work item: Scope Issue #2. No extra prerequisite Issues,
  replacement scheduler, shared Runner pool or persistent control service.
- Administrator-owned verified Core installation and policies; a dedicated
  non-root controller/Runner account, private state and the existing rootless
  Docker backend. The Agent never receives the Docker socket or host privileges.

This requests use of existing GitHub Actions capacity, not a new product host-OS
requirement. It does not require changes to the Owner's Windows/WSL settings.

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

Privileged identity provisioning needs separate Owner authorization. Use a new
dedicated Codex ChatGPT login session through a private supported login flow;
preserve the existing login. If an encrypted repository-secret channel is used,
the Owner must approve that channel and the dedicated session's remote use.
Do not publish login links/codes, auth files, refresh tokens or credentials in
Actions logs, artifacts, Issues, source files or chat.

The GitHub controller credential must be limited to this test repository and
the actually required native administration/Actions/Contents/Issues/PR access.
Do not export the existing broadly scoped workstation credential. Store only
private file references in fixed host adoption; no request can select tokens,
executables, sockets, policies or adapters. Agents and Hooks receive neither
the controller credential nor another role's private state.

All external fork contributors require workflow-run approval. Keep CI hosted
and read-only; permit only reviewed fixed entry workflows to reach the adopted
Runner. A routing label is not authorization. Never approve an untrusted fork
workflow merely to exercise a negative test.

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

Owner approval must cover the bounded remote VM/Runner setup and the private
dedicated GitHub/Codex identity-provisioning channel. Repository/Issue approval
alone does not grant those privileges. This document is a plan, not evidence
that the host, authenticated Agent or complete protected E2E has passed.
