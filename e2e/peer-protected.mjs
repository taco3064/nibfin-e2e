import { fixtureBudget } from './fixture-budget.mjs';
import { sourceIdentities, sameSources }
  from './scenarios/cli-onboarding/installation-observations.mjs';
import { bindingKeys, same, validPeerBinding, installedRecord,
  peerTemplates, peerObservation } from './peer-observations.mjs';

// Operator library only. Workers cannot supply these capabilities or bindings.
// Adoption calls the existing Core capability; no command/credential selection.
export function protectedPeerEnrollment({ sources, inventory, context, bounds = {} }) {
  if (typeof inventory?.exclusive !== 'function' ||
      ['authorize', 'observe', 'adopt', 'reconcile'].some(k =>
        typeof context?.[k] !== 'function') ||
      !['operator', 'synthetic'].includes(context.origin) ||
      !validPeerBinding(context.binding)) {
    throw new Error('PROTECTED_PEER_CONTEXT_REQUIRED');
  }
  const binding = Object.fromEntries(bindingKeys.map(k => [k, context.binding[k]]));
  const identities = sourceIdentities(sources);
  if (Object.values(identities).some(s => !s.repository || !s.commit)) {
    throw new Error('PREPARED_PEER_SOURCES_REQUIRED');
  }
  const origin = context.origin;
  return Object.freeze({
    enroll() {
      return inventory.exclusive(async (state, save) => {
        const budget = fixtureBudget(bounds);
        let record;
        let result = { origin, disposition: 'incomplete', code: 'PEER_UNVERIFIED' };
        try {
          const installation = state.installation;
          if (state.actor !== binding.memberId ||
              state.definition?.owner !== binding.owner ||
              !installedRecord(installation, binding, identities) ||
              !state.repositories?.some(r => r.repository === binding.repository &&
                r.native?.id === binding.repositoryId && r.creation === 'settled' &&
                r.seed === 'settled' && r.marker === state.definition.marker &&
                r.account?.id === binding.memberId &&
                r.native?.fullName === binding.repository &&
                r.native?.owner?.id === binding.memberId)) {
            throw new Error('INSTALLATION_REQUIRED');
          }
          const peers = installation.peers ??= {};
          record = peers[binding.repositoryId];
          if (record && (!same(record.binding, binding, bindingKeys) ||
              !sameSources(record.sources, identities))) {
            throw new Error('PEER_INVENTORY_CONFLICT');
          }
          if (await budget.call(signal => context.authorize({ ...binding,
            operation: 'enroll-peer', signal })) !== true) {
            return { origin, disposition: 'denied', code: 'PEER_PERMISSION_UNAVAILABLE' };
          }
          const templates = await budget.call(() => peerTemplates({ ...sources,
            memberId: binding.memberId }));
          record ??= peers[binding.repositoryId] = { binding, sources: identities,
            sequence: 0, pending: null };
          await save();
          const inspect = async () => peerObservation(await budget.call(signal =>
            context.observe(structuredClone(binding), { signal })), binding,
          identities, templates, installation.runners);
          let observed = await inspect();
          if (!observed) throw new Error('PEER_READBACK_REQUIRED');
          const reconcile = async () => {
            const r = await budget.call(signal => context.reconcile(
              structuredClone(binding), structuredClone(record.pending), { signal }));
            if (r?.terminated !== true || r.effects !== 'reconciled') {
              throw new Error('PEER_EFFECTS_UNKNOWN');
            }
            observed = await inspect();
            if (!observed) throw new Error('PEER_READBACK_REQUIRED');
            record.pending = null;
            await save();
          };
          if (record.pending) await reconcile();
          if (record.observation && !observed.adopted) {
            throw new Error('PEER_ADOPTION_LOST');
          }
          if (!observed.adopted) {
            budget.operation();
            record.pending = { operation: 'adopt-shared-peer',
              sequence: ++record.sequence };
            await save();
            // A response alone never establishes adoption or termination.
            await budget.call(signal => context.adopt(structuredClone(binding), {
              signal, intent: structuredClone(record.pending),
              sources: structuredClone(identities),
            }));
            await reconcile();
          }
          if (observed.adopted) {
            record.observation = observed;
            await save();
            result = { ...observed, origin, disposition: 'success',
              code: 'PEER_ENROLLED' };
          }
        } catch (error) {
          if (error?.code === 'PEER_PERMISSION_DENIED') result = {
            origin, disposition: 'denied', code: 'PEER_PERMISSION_UNAVAILABLE',
          };
          // No raw provider diagnostics, command output or credentials escape.
        }
        return { ...result, recoveryPending: !!record?.pending };
      });
    },
  });
}
