const clone = value => structuredClone(value);

export function simulatedContexts(provider, prepared, scope) {
  const d = provider.definition;
  const repository = d.repositories[0];
  const binding = { owner: d.owner, hostId: 'simulated-host', repository,
    repositoryId: provider.repositoryId(repository), memberId: d.account.id };
  const endpoint = `https://github.com/${repository}`;
  const identities = Object.fromEntries(Object.entries(prepared.sources).map(
    ([id, source]) => [id, { repository: source.repository, commit: source.commit }],
  ));
  const check = request => {
    provider.authorize('observe', request.repository, request.memberId);
    if (Object.keys(binding).some(key => request[key] !== binding[key])) {
      throw new Error('SIM_INSTALLATION_BINDING_CONFLICT');
    }
    provider.requirePublic(repository);
  };
  const installation = { origin: 'synthetic', binding,
    credentials: { capabilities: async () => ({ user: { status: 'validated',
      role: 'User', actorId: d.account.id, ownerId: d.account.id, repository } }) },
    async authorize(request) {
      scope('install');
      check(request);
      return ['inspect-installation', 'start-shared-services']
        .includes(request.operation);
    },
    async observe(request) {
      check(request);
      const row = provider.repository(repository);
      return { binding: clone(binding), sources: clone(identities),
        installation: clone(row.installation), host: { ready: true,
          serviceUser: 'simulated-runner', serviceState: row.service },
        endpoint, registrationsComplete: true,
        runners: clone(provider.sharedRegistrations(repository)) };
    },
    async command(file, args, settings) {
      check(settings.binding);
      if (file !== prepared.sources.cli.output.entry || JSON.stringify(args) !==
          JSON.stringify(['init', '--repo', repository, '--apply',
            '--start-shared-services'])) provider.network();
      return provider.perform('install', repository, () => {
        const row = provider.requirePublic(repository);
        if (!row.seeded) throw new Error('SIM_SEED_REQUIRED');
        for (const id of [...provider.slotIds.map(String), 'shared']) {
          const target = provider.targets.get(id);
          const runner = provider.registrations.get(Number(id));
          if ((target && target.owner !== d.owner) || (runner &&
              (runner.memberId !== d.account.id ||
                runner.repositoryId !== binding.repositoryId))) {
            throw new Error('SIM_HOST_RESOURCE_CONFLICT');
          }
        }
        for (const id of provider.slotIds) {
          const name = `runner-${id}`;
          provider.registrations.set(id, { id, name, memberId: d.account.id,
            repositoryId: binding.repositoryId, endpoint, localId: id,
            localName: name, shared: true, status: 'online' });
          provider.targets.set(String(id), { kind: 'registration', id: String(id),
            hostId: binding.hostId, owner: d.owner, active: false, absent: false });
        }
        provider.targets.set('shared', { kind: 'service', id: 'shared',
          hostId: binding.hostId, owner: d.owner, active: true,
          stopped: false, absent: false });
        row.service = 'active';
        row.installed = true;
        return { exitCode: 2, terminated: true, stdout: JSON.stringify({
          status: 'pending', code: 'SHARED_PROTECTED_EXECUTION_UNVERIFIED',
          shared_runners: provider.sharedRegistrations(repository),
        }), stderr: '' };
      });
    },
    async reconcile() {
      return { terminated: provider.settled, effects: provider.effects };
    },
  };
  const teardown = {
    async authorize(definition) {
      scope('cleanup');
      return definition.owner === d.owner && provider.pending.size === 0;
    },
    async exclude() { provider.exclude(); },
    async execution() {
      return { excluded: provider.excluded, settled: provider.settled,
        effects: provider.effects };
    },
    async discover() {
      return { complete: true, targets: [...provider.targets.values()]
        .filter(target => target.owner === d.owner).map(target => ({
          kind: target.kind, id: target.id, hostId: target.hostId, owner: target.owner,
        })) };
    },
    async observe(target) {
      const row = provider.targets.get(target.id);
      if (!row || Object.keys(target).some(key => row[key] !== target[key])) {
        throw new Error('SIM_RESOURCE_UNRELATED');
      }
      return { ...clone(row), owned: true, independent: true, complete: true };
    },
    async mutate(operation, target) {
      const row = provider.targets.get(target?.id);
      if (!provider.excluded || !provider.settled || !row ||
          row.owner !== d.owner || target.owner !== row.owner ||
          target.hostId !== row.hostId) throw new Error('SIM_REMOVAL_UNSAFE');
      if (operation === 'stop' && row.kind === 'service') {
        row.active = false;
        row.stopped = true;
        provider.repository(repository).service = 'inactive';
      } else if (operation === 'remove' && !row.active) {
        row.absent = true;
        provider.registrations.delete(Number(row.id));
      } else throw new Error('SIM_OPERATION_DENIED');
    },
    async baseline() {
      return provider.settled && [...provider.targets.values()].every(target =>
        target.owner === d.owner || !target.absent);
    },
    async repository(record) {
      return provider.repositoryEvidence(record);
    },
    async deleteRepository(record) { provider.remove(record.repository); },
    async receipt(record) { return provider.receipt(record); },
    credentials: { revoke: async () => {
      provider.revoke();
      return { status: 'revoked' };
    } },
  };
  const provisioning = {
    context: { authorize: async request => {
      scope('provision');
      return request.owner === d.owner && request.actor === d.account.id;
    }, idle: async () => provider.settled,
    receipt: async record => provider.receipt(record) },
    provider: () => ({ preflight: async () => d.account.id,
      observe: async record => {
        provider.authorize('observe', record.repository);
        return clone(provider.repositories.get(record.repository)?.native ?? null);
      },
      createRepository: async record => provider.create(record),
      seedRepository: async record => provider.perform('seed', record.repository,
        () => {
          const row = provider.repository(record.repository);
          row.seeded = true;
          row.installation = { pullRequest: { number: 1,
            headCommit: 'a'.repeat(40), repositoryId: row.native.id },
          checks: 'passed', reviewed: true, merged: true, contentMatches: true };
        }),
      seedObserved: async record => {
        const seeded = provider.repository(record.repository).seeded;
        // The lifecycle has already independently verified this original create
        // and recorded settlement before it asks about the seed.
        if (seeded && record.creation === 'settled') {
          provider.resolve('create', record.repository);
        }
        return seeded;
      },
    }),
  };
  return { repository: provisioning, installation: { context: installation },
    teardown: { context: teardown } };
}
