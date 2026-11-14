// Callable only by the protected owner, never exported to scenario workers.
// Context owns durable exclusive storage, native inspections and credentials.
// Input contains no actor, target, operation, executable or authorization flag.
export function protectedRunnerScenarios({ sources, context }) {
  const required = ['exclusive', 'authorize', 'command', 'inspect', 'allocate',
    'idle', 'receipt'];
  if (!sources?.cli?.output?.entry || required.some(
    key => typeof context?.[key] !== 'function',
  )) throw new Error('PROTECTED_RUNNER_CONTEXT_REQUIRED');
  const source = { repository: sources.cli.repository, commit: sources.cli.commit };
  const bound = context.target;
  if (!bound || !Number.isSafeInteger(bound.actor) || bound.actor <= 0 ||
      !Number.isSafeInteger(bound.repositoryId) || bound.repositoryId <= 0 ||
      !/^[\w.-]+\/[\w.-]+$/.test(bound.repository ?? '')) {
    throw new Error('PROTECTED_RUNNER_TARGET_REQUIRED');
  }
  const target = { repository: bound.repository,
    repositoryId: bound.repositoryId, actor: bound.actor };
  const authorize = async operation => {
    if (await context.authorize({ ...target, operation }) !== true) {
      throw new Error('RUNNER_AUTHORIZATION_DENIED');
    }
  };
  async function command(operation, record) {
    await authorize(operation);
    const args = operation === 'preflight' ? ['preflight'] : ['runner', operation];
    args.push('--repo', target.repository);
    if (operation !== 'list') args.push('--directory', record.directory);
    if (operation === 'create') args.push('--name', record.name);
    if (!['list', 'preflight'].includes(operation)) args.push('--apply');
    const result = await context.command(sources.cli.output.entry, args);
    return decodeRunnerCommand(result);
  }
  const same = (record, observed) => observed?.repository === target.repository &&
    observed.repositoryId === target.repositoryId &&
    observed.memberId === target.actor && observed.runnerId === record.runnerId &&
    observed.local?.agentId === record.runnerId &&
    observed.local?.agentName === record.name &&
    observed.local?.gitHubUrl === `https://github.com/${target.repository}` &&
    observed.native?.id === record.runnerId && observed.native?.name === record.name &&
    observed.native.labels?.some(label => label.name === `nibfin-user-${target.actor}`);
  const execute = action => context.exclusive(async (state, save) => {
    state.observations ??= [];
    try {
      if (state.target && (state.target.repository !== target.repository ||
          state.target.repositoryId !== target.repositoryId ||
          state.target.actor !== target.actor)) {
        throw new Error('RUNNER_INVENTORY_TARGET_MISMATCH');
      }
      if (!state.target) {
        if (state.resource || state.phase) throw new Error('RUNNER_INVENTORY_UNBOUND');
        state.target = structuredClone(target);
        await save();
      }
      await action(state, save);
      return { evidence: 'live', source, target, state: state.phase,
        observations: structuredClone(state.observations),
        protectedExecution: 'unverified' };
    } catch {
      // Raw process/provider/login diagnostics never cross this boundary.
      return { evidence: 'live', source, target, state: state.phase ?? 'unavailable',
        reason: 'RUNNER_EXECUTION_INCOMPLETE_INSPECT_BEFORE_RETRY',
        observations: structuredClone(state.observations),
        protectedExecution: 'unverified' };
    }
  });
  async function mutation(state, save, operation) {
    await authorize(operation);
    state.phase = `${operation}-pending`;
    await save();
    const result = await command(operation, state.resource);
    state.observations.push({ operation, ...result });
    await save();
    if (result.exit !== 0 || result.results.at(-1)?.status !== 'completed') {
      throw new Error('RUNNER_EFFECT_UNRESOLVED');
    }
    return result.results.at(-1)?.record;
  }
  return Object.freeze({
    setup() {
      return execute(async (state, save) => {
        if (state.phase || state.resource) throw new Error('RUNNER_ALREADY_INVENTORIED');
        await authorize('create');
        // allocate must atomically reserve a fresh disposable private directory
        // and journal native allocation ownership, not discover a named resource.
        state.resource = await context.allocate(target);
        state.phase = 'allocation-owned';
        await save();
        await mutation(state, save, 'create');
        const registered = await mutation(state, save, 'register');
        state.resource.runnerId = registered?.runner_id;
        await save();
        const receipt = await context.receipt(structuredClone(state.resource), target);
        const observed = await context.inspect(structuredClone(state.resource), target);
        if (receipt?.createdByThisExecution !== true ||
            receipt.runnerId !== state.resource.runnerId ||
            !same(state.resource, observed)) throw new Error('RUNNER_OWNERSHIP_UNPROVEN');
        state.phase = 'registered';
        state.observations.push({ operation: 'inspect', ...safeInspection(observed) });
        await save();
      });
    },
    inspect() {
      return execute(async (state, save) => {
        if (!state.resource) throw new Error('RUNNER_RESOURCE_REQUIRED');
        for (const operation of ['list', 'preflight']) {
          state.observations.push({ operation,
            ...await command(operation, state.resource) });
          await save();
        }
      });
    },
    cleanup({ remoteOnly = false } = {}) {
      return execute(async (state, save) => {
        if (!['registered', 'remote-removed-local-config-retained'].includes(
          state.phase,
        )) throw new Error('RUNNER_RECONCILIATION_REQUIRED');
        const resource = structuredClone(state.resource);
        const receipt = await context.receipt(resource, target);
        const observed = await context.inspect(resource, target);
        if (receipt?.createdByThisExecution !== true ||
            receipt.runnerId !== resource.runnerId ||
            await context.idle(resource, target) !== true || observed?.serviceManaged ||
            observed?.active !== false) throw new Error('RUNNER_USAGE_UNRESOLVED');
        if (state.phase === 'registered' && (!same(resource, observed) ||
            observed.native.busy !== false || observed.native.status !== 'offline')) {
          throw new Error('RUNNER_CLEANUP_IDENTITY_OR_USAGE_UNPROVEN');
        }
        if (state.phase === 'remote-removed-local-config-retained' &&
            observed.remoteAbsent !== true) throw new Error('RUNNER_ABSENCE_UNPROVEN');
        const operation = remoteOnly ? 'remove' : 'unregister';
        const record = await mutation(state, save, operation);
        const after = await context.inspect(resource, target);
        if (after?.remoteAbsent !== true ||
            (!remoteOnly && after.localConfiguration !== false)) {
          throw new Error('RUNNER_CLEANUP_UNCONFIRMED');
        }
        state.phase = record?.state;
        state.observations.push({ operation: 'cleanup-inspect',
          remoteAbsent: true, localConfiguration: after.localConfiguration });
        // Files remain owned by the protected allocator. This scenario never
        // removes directories; retirement requires its native usage confirmation.
        await save();
      });
    },
  });
}

function safeInspection(value) {
  return { repository: value.repository, repositoryId: value.repositoryId,
    memberId: value.memberId, runnerId: value.runnerId,
    local: value.local && { agentId: value.local.agentId,
      agentName: value.local.agentName, gitHubUrl: value.local.gitHubUrl },
    native: value.native && { id: value.native.id, name: value.native.name,
      status: value.native.status, busy: value.native.busy,
      labels: value.native.labels?.map(label => ({ name: label.name })) } };
}

// Accept whitespace-separated JSON values, including multiline preflight JSON.
// Do not retain stderr or raw errors, even when a command fails before preview.
export function decodeRunnerCommand({ exitCode, stdout }) {
  if (![0, 1, 2].includes(exitCode) || typeof stdout !== 'string' ||
      stdout.length > 1024 * 1024) throw new Error('RUNNER_OUTPUT_UNAVAILABLE');
  const values = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < stdout.length; i++) {
    const char = stdout[i];
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new Error('RUNNER_OUTPUT_INVALID');
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    if (depth === 0 && !quoted) {
      const value = JSON.parse(stdout.slice(start, i + 1));
      // Only CLI documented bounded outcome fields cross into scenario evidence.
      const safe = {};
      for (const key of ['status', 'command', 'core_binding', 'service_changes',
        'repository', 'protected_execution', 'host_os', 'host_arch']) {
        if (typeof value[key] === 'string' && value[key].length <= 256) {
          safe[key] = value[key];
        }
      }
      if (value.record) safe.record = {
        repository: value.record.repository, repository_id: value.record.repository_id,
        member_id: value.record.member_id, runner_id: value.record.runner_id,
        name: value.record.name, state: value.record.state,
      };
      if (Array.isArray(value.checks)) safe.checks = value.checks.map(check => ({
        name: check.name, status: check.status, code: check.code,
      }));
      if (Array.isArray(value.runners)) safe.runners = value.runners.map(native =>
        safeInspection({ native }).native);
      values.push(safe);
      start = -1;
    }
  }
  if (start >= 0) throw new Error('RUNNER_OUTPUT_INCOMPLETE');
  return { exit: exitCode, results: values };
}
