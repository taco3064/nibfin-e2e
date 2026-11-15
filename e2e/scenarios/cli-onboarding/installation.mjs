import { randomUUID } from 'node:crypto';
import { invocationReadback } from './invocation-readback.mjs';
import { fixtureBudget } from '../../fixture-budget.mjs';
import { verifyCompatibility } from '../../source-producers.mjs';
import { decodeRunnerCommand } from '../../runner-command.mjs';
import { installationId, installationText, sourceIdentities, sameSources,
  installationObservation, compareInstallation } from './installation-observations.mjs';

const clone = value => structuredClone(value);
const conflicts = new Set(['binding-conflict', 'source-conflict', 'endpoint-conflict',
  'registration-conflict', 'checks-failed']);

// Protected composition only. No scenario request can choose a target, executable,
// host, credentials or authorization. Storage is the upstream exclusive inventory.
export function protectedSharedInstallation({
  sources, inventory, context, bounds = {}, invocationRun = null,
}) {
  const required = ['authorize', 'observe', 'command', 'reconcile'];
  if (typeof inventory?.exclusive !== 'function' ||
      typeof inventory.path !== 'string' || inventory.path.length > 4096 ||
      required.some(key => typeof context?.[key] !== 'function') ||
      typeof context?.credentials?.capabilities !== 'function' ||
      !['synthetic', 'operator'].includes(context.origin)) {
    throw new Error('PROTECTED_INSTALLATION_CONTEXT_REQUIRED');
  }
  if (invocationRun && (!installationText(invocationRun.runId) ||
      !installationId(invocationRun.attempt))) {
    throw new Error('PROTECTED_INVOCATION_RUN_REQUIRED');
  }
  const run = invocationRun ? clone(invocationRun) : null;
  const b = context.binding;
  if (!installationText(b?.owner) || !installationText(b?.hostId) ||
      !/^[\w.-]+\/[\w.-]+$/.test(b?.repository ?? '') ||
      !installationId(b?.repositoryId) || !installationId(b?.memberId)) {
    throw new Error('PROTECTED_INSTALLATION_BINDING_REQUIRED');
  }
  const binding = Object.fromEntries(['owner', 'hostId', 'repository',
    'repositoryId', 'memberId'].map(key => [key, b[key]]));
  const identities = sourceIdentities(sources);
  if (!sources?.cli?.output?.entry || Object.values(identities).some(
    s => !s.repository || !s.commit,
  )) throw new Error('PREPARED_INSTALLATION_SOURCES_REQUIRED');
  const origin = context.origin;
  const entry = sources.cli.output.entry;
  if (run && (typeof entry !== 'string' || entry.length > 4096)) {
    throw new Error('PREPARED_INVOCATION_ENTRY_REQUIRED');
  }
  return Object.freeze({
    install() {
      return inventory.exclusive(async (state, save) => {
        const budget = fixtureBudget(bounds);
        const call = action => budget.call(action);
        const invocation = run ? { runId: run.runId, attempt: run.attempt,
          id: randomUUID(), entry } : null;
        let invoked = false;
        let invocationObservations = null;
        let terminated = false;
        let phase = 'binding';
        let disposition = 'incomplete';
        let refused = null;
        let observed = null;
        let record;
        const authorize = async operation => {
          if (await call(signal => context.authorize({ ...binding, operation,
            signal })) !== true) {
            refused = { operation, memberId: binding.memberId,
              expectedRole: operation === 'start-shared-services' ?
                'host-administrator' : 'authenticated-member' };
            throw new Error('INSTALLATION_DENIED');
          }
        };
        const inspect = async () => {
          const raw = await call(signal => context.observe(
            clone(binding), { signal, intent: clone(record?.pending ?? null),
              invocation: clone(invocation) },
          ));
          observed = installationObservation(raw);
          invocationObservations = invoked ?
            invocationReadback(raw, invocation, origin) : null;
          phase = compareInstallation(binding, identities, observed, record.runners);
          if (conflicts.has(phase)) {
            disposition = 'contradiction';
            throw new Error('INSTALLATION_CONTRADICTION');
          }
          // Store only validated, independently bound identities, not raw responses.
          if (phase !== 'unknown') {
            record.runners = clone(observed.runners);
            record.observation = clone(observed);
            await save();
          }
        };
        try {
          const d = state.definition;
          const repositories = state.repositories;
          if (d?.owner !== binding.owner || state.actor !== binding.memberId ||
              d.account?.id !== binding.memberId || !Array.isArray(repositories) ||
              repositories.length !== 2 || repositories.some((r, i) =>
                r.repository !== d.repositories?.[i] || r.creation !== 'settled' ||
                r.seed !== 'settled' || r.marker !== d.marker ||
                r.account?.id !== binding.memberId ||
                r.native?.fullName !== r.repository ||
                r.native?.owner?.id !== binding.memberId ||
                !installationId(r.native?.id)) ||
              new Set(repositories.map(r => r.native.id)).size !== 2 ||
              !repositories.some(r => r.repository === binding.repository &&
                r.native.id === binding.repositoryId)) {
            disposition = 'contradiction';
            throw new Error('UPSTREAM_INVENTORY_BINDING_CONFLICT');
          }
          const existing = state.installation;
          if (existing && (Object.keys(binding).some(key =>
            existing.binding?.[key] !== binding[key]) ||
            !sameSources(existing.sources, identities))) {
            disposition = 'contradiction';
            throw new Error('INSTALLATION_INVENTORY_CONFLICT');
          }
          record = existing;
          await authorize('inspect-installation');
          const credentials = await call(() => context.credentials.capabilities());
          const user = credentials?.user;
          if (user?.status !== 'validated' || user.role !== 'User' ||
              user.actorId !== binding.memberId || user.ownerId !== binding.memberId ||
              user.repository !== binding.repository) {
            disposition = 'contradiction';
            throw new Error('INSTALLATION_CREDENTIAL_BINDING_CONFLICT');
          }
          phase = 'source-compatibility';
          if (!sameSources({ ...identities, core: sources.core.output?.pin },
            identities)) {
            disposition = 'contradiction';
            throw new Error('PREPARED_CORE_SOURCE_CONFLICT');
          }
          await call(() => verifyCompatibility(sources, sources.core.output));
          record = existing ?? { binding: clone(binding), sources: clone(identities),
            phase: 'inspection', runners: [], pending: null, sequence: 0 };
          state.installation = record;
          await save();
          await inspect();
          if (phase === 'unknown') throw new Error('INSTALLATION_READBACK_UNKNOWN');
          if (record.pending) {
            // A timeout is not termination. Native reconciliation must establish
            // termination AND account for all effects before another apply.
            const reconciled = await call(signal => context.reconcile(
              clone(binding), clone(record.pending), { signal },
            ));
            if (reconciled?.terminated !== true || reconciled.effects !== 'reconciled') {
              phase = 'reconciliation';
              throw new Error('INSTALLATION_EFFECTS_UNKNOWN');
            }
            await inspect();
            if (phase === 'unknown') throw new Error('INSTALLATION_READBACK_UNKNOWN');
            record.pending = null;
            await save();
          }
          if (phase === 'installed' && !invocation) {
            disposition = 'success';
          } else if (!['installation-pr', 'host-prerequisites'].includes(phase)) {
            await authorize('start-shared-services');
            budget.operation();
            record.pending = { operation: 'init', sequence: ++record.sequence,
              ...(invocation ? { invocation: clone(invocation) } : {}) };
            record.phase = 'apply-pending';
            await save();
            // This invocation can only consume an externally reviewed, merged
            // installation. It never publishes or merges its own installation PR.
            invoked = true;
            const result = await call(signal => context.command(entry,
              ['init', '--repo', binding.repository, '--apply',
                '--start-shared-services'], { signal, stdin: 'ignore',
                timeoutMs: bounds.requestTimeoutMs ?? 5000, limit: 1024 * 1024,
                binding: clone(binding), intent: clone(record.pending) }));
            if (result?.terminated !== true) {
              phase = 'reconciliation';
              throw new Error('INSTALLATION_TERMINATION_UNKNOWN');
            }
            terminated = true;
            const command = decodeRunnerCommand(result);
            await inspect();
            // A bounded process failure does not establish absence of effects.
            // Keep the intent until protected reconciliation on the next call.
            if (![0, 2].includes(command.exit) || phase === 'unknown') {
              throw new Error('INSTALLATION_COMMAND_INCOMPLETE');
            }
            const reconciled = await call(signal => context.reconcile(
              clone(binding), clone(record.pending), { signal },
            ));
            if (reconciled?.terminated !== true || reconciled.effects !== 'reconciled') {
              phase = 'reconciliation';
              throw new Error('INSTALLATION_EFFECTS_UNKNOWN');
            }
            record.pending = null;
            await save();
            if (invocation) await inspect();
            if (phase === 'installed' && (!invocation || invocationObservations)) {
              disposition = 'success';
            }
          }
        } catch (error) {
          // Adapters may expose this typed refusal, never raw provider errors.
          const operations = ['read-installation-pr', 'read-runner-registrations',
            'register-shared-runners', 'start-shared-services'];
          if (error?.code === 'INSTALLATION_PERMISSION_DENIED' &&
              operations.includes(error.operation)) {
            refused = { operation: error.operation, memberId: binding.memberId,
              expectedRole: error.operation === 'start-shared-services' ?
                'host-administrator' : 'repository-administrator' };
          }
          if (refused) disposition = 'denied';
          if (['INCOMPATIBLE_CORE_SOURCE', 'INCOMPATIBLE_ACTION_SOURCE'].includes(
            error?.message,
          )) disposition = 'contradiction';
          // Never return exception text, stdout, stderr or credential material.
        }
        if (record) {
          record.phase = phase;
          await save();
        }
        return { origin, binding: clone(binding), sources: clone(identities),
          phase, disposition, refused, observation: observed,
          ...(invocation ? { invocation: { ...invocation, invoked, terminated,
            observations: clone(invocationObservations),
            confirmed: disposition === 'success' && invocationObservations !== null,
            evidence: disposition === 'success' && invocationObservations ?
              (origin === 'operator' ? 'native' : 'controlled') : 'unverified' } } : {}),
          protectedExecution: 'unverified',
          inventory: { path: inventory.path, owner: binding.owner,
            hostId: state.installation?.binding?.hostId ?? binding.hostId,
            repositories: (state.repositories ?? []).map(r =>
              ({ repository: installationText(r.repository) ? r.repository : null,
                id: installationId(r.native?.id) ? r.native.id : null })),
            runners: clone(state.installation?.runners ?? []),
            pending: clone(state.installation?.pending ?? null) } };
      });
    },
  });
}
