import { fixtureLifecycle } from './fixture-lifecycle.mjs';
import { repositoryIdentity, repositoryNative } from './repository-definition.mjs';

const clone = value => structuredClone(value);
export const requireTeardown = value => {
  if (!value) throw new Error('TEARDOWN_UNRESOLVED');
};
const require = requireTeardown;
const text = value => typeof value === 'string' &&
  /^[A-Za-z0-9_./:@-]{1,256}$/.test(value);

export async function cleanupHost(tools) {
  const { state, record, save, call, intent, context } = tools;
  const d = state.definition;
  require(await call(signal => context.baseline(clone(state),
    { signal })) === true);
  // Discovery consumes the complete current inventory, not an initial list.
  // It must account for partial installation and late delivery additions.
  const host = await call(signal => context.discover(clone(state), { signal }));
  require(host?.complete === true && Array.isArray(host.targets) &&
    host.targets.length <= 100);
  const keys = new Set();
  for (const target of host.targets) {
    require(['service', 'registration'].includes(target.kind) &&
      text(target.id) && text(target.hostId) && target.owner === d.owner &&
      !keys.has(`${target.kind}:${target.id}`));
    keys.add(`${target.kind}:${target.id}`);
  }
  for (const old of record.targets ?? []) {
    require(host.targets.some(t => t.kind === old.kind &&
      t.id === old.id && t.hostId === old.hostId && t.owner === old.owner));
  }
  record.targets = host.targets.map(t => ({ kind: t.kind, id: t.id,
    hostId: t.hostId, owner: t.owner }));
  await save();
  for (const runner of state.installation?.runners ?? []) {
    require(host.targets.some(t => t.kind === 'registration' &&
      t.id === String(runner.id) &&
      t.hostId === state.installation.binding.hostId));
  }
  const ordered = host.targets.toSorted((left, right) =>
    Number(left.kind === 'registration') - Number(right.kind === 'registration'));
  for (const target of ordered) {
    const safe = { kind: target.kind, id: target.id, hostId: target.hostId,
      owner: target.owner };
    const key = `${safe.kind}:${safe.hostId}:${safe.id}`;
    const inspect = async () => {
      const o = await call(signal => context.observe(clone(safe), { signal }));
      require(o?.independent === true && o.complete === true &&
        o.owner === safe.owner && o.id === safe.id &&
        o.hostId === safe.hostId && o.kind === safe.kind);
      // Terminal facts must agree before any predicate can accept them.
      require(typeof o.absent === 'boolean' && typeof o.active === 'boolean' &&
        !(o.absent && o.active));
      if (safe.kind === 'service') {
        require(typeof o.stopped === 'boolean' && !(o.stopped && o.active));
      }
      return o;
    };
    const mutate = operation => call(signal => context.mutate(operation,
      clone(safe), clone(state), { signal }));
    if (safe.kind === 'service') {
      await intent(key, 'stop', async () => {
        require((await inspect()).owned === true);
        await mutate('stop');
      }, async () => {
        const o = await inspect();
        return o.absent === true || o.stopped === true;
      });
    }
    await intent(key, 'remove', async () => {
      const o = await inspect();
      require(o.owned === true && o.active === false &&
        (safe.kind !== 'service' || o.stopped === true));
      await mutate('remove');
    }, async () => (await inspect()).absent === true);
  }
}

export async function cleanupFixtures(tools) {
  const { state, save, call, context, bounds, inventory } = tools;
  if (state.resources.length) {
    require(typeof context.fixtureProvider === 'function' &&
      typeof context.fixtureContext?.authorize === 'function' &&
      typeof context.fixtureContext?.idle === 'function');
    // Reuse ordinary fixture ownership and cleanup semantics under this
    // already-held inventory lock; never acquire a second nested lock.
    const provider = (innerBudget, definition) => Object.fromEntries(
      Object.entries(context.fixtureProvider(innerBudget, definition))
        .map(([key, fn]) => [key, (...args) => call(() => fn(...args))]),
    );
    const fixtureContext = Object.fromEntries(
      Object.entries(context.fixtureContext).map(([key, fn]) =>
        [key, (...args) => call(() => fn(...args))]),
    );
    const fixtures = fixtureLifecycle({ inventory: { path: inventory.path,
      exclusive: action => action(state, save) }, provider,
    context: fixtureContext, bounds });
    require((await fixtures.reconcile()).state === 'passing');
    require((await fixtures.teardown()).state === 'passing');
    require(state.resources.every(r =>
      ['cleaned', 'retained'].includes(r.state)));
  }
}

export async function cleanupRepositories(tools) {
  const { state, save, call, intent, context } = tools;
  const d = state.definition;
  require(Array.isArray(d.repositories) && d.repositories.length === 2 &&
    d.account?.id === state.actor &&
    d.marker === `nibfin-disposable:${d.owner}`);
  const repositories = state.repositories ?? [];
  require(repositories.length <= 2 &&
    new Set(repositories.map(r => r.repository)).size === repositories.length &&
    new Set(repositories.filter(r => r.native).map(r => r.native.id)).size ===
      repositories.filter(r => r.native).length);
  for (const r of repositories) {
    require(d.repositories.includes(r.repository) &&
      r.repository !== d.repository && r.marker === d.marker &&
      r.account?.id === d.account.id &&
      r.account?.login === d.account.login &&
      d.repositories.some((name, i) => name === r.repository &&
        name === `${d.account.login}/nibfin-${d.owner}-${i + 1}`));
    if (!r.native) {
      const receipt = await call(signal => context.receipt(clone(r),
        clone(d), { signal }));
      require(receipt?.operation === r.operation &&
        repositoryIdentity(d, r, receipt.native));
      r.native = repositoryNative(receipt.native);
      await save();
    }
    const absent = async () => {
      const o = await call(signal => context.repository(clone(r),
        clone(d), { signal }));
      require(o?.independent === true && o.complete === true &&
        o.repository === r.repository && o.id === r.native.id &&
        o.accountId === d.account.id && o.access === 'verified');
      if (o.absent === true) return true;
      require(repositoryIdentity(d, r, o.native));
      return false;
    };
    await intent(r.repository, 'delete', () => call(signal =>
      context.deleteRepository(clone(r), clone(d), { signal })), absent);
  }
}
