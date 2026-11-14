import { randomUUID } from 'node:crypto';
import { FixtureError } from './fixture-errors.mjs';
import { mutationObserved } from './fixture-issue.mjs';

// Called only under both durable inventory locks. An Issue number or public marker
// cannot substitute for a freshly owned peer inventory from the protected caller.
export async function addOwnedDependency(tools, peer, helpers) {
  const { state, save, budget, api, authorize, readOwned } = tools;
  const { identity, unresolved, clone } = helpers;
  budget.operation();
  if (unresolved(state) || unresolved(peer)) {
    throw new FixtureError('FIXTURE_RECONCILIATION_REQUIRED');
  }
  const record = state.resources.find(item => item.kind === 'issue');
  const upstream = peer.resources.find(item => item.kind === 'issue');
  if (!record || !upstream || record.state !== 'owned' || upstream.state !== 'owned' ||
      peer.definition.repository !== state.definition.repository ||
      peer.definition.owner === state.definition.owner || peer.actor !== state.actor ||
      upstream.native.id === record.native.id ||
      upstream.native.number === record.native.number) {
    throw new FixtureError('FIXTURE_DISTINCT_OWNED_ISSUES_REQUIRED');
  }
  if (record.dependency) throw new FixtureError('FIXTURE_DEPENDENCY_ALREADY_SET');
  await authorize('add-blocked-by');
  const before = await readOwned(record);
  const native = await api.read(clone(upstream));
  if (before.state !== 'open' || native?.state !== 'open' ||
      !identity(peer.definition, upstream, native, peer.actor) ||
      native.id !== upstream.native.id || native.number !== upstream.native.number) {
    throw new FixtureError('FIXTURE_IDENTITY_MISMATCH');
  }
  record.mutation = { kind: 'add-blocked-by', operation: randomUUID(),
    upstream: clone(upstream.native) };
  // Preserve intent across a lost write response. Reconcile observes; never replays.
  await save();
  await api.mutateIssue(clone(record));
  if (!mutationObserved(await readOwned(record), record.mutation)) {
    throw new FixtureError('FIXTURE_DEPENDENCY_EFFECT_UNKNOWN');
  }
  record.dependency = clone(upstream.native);
  delete record.mutation;
  await save();
}
