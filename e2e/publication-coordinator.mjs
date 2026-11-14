import { createReleaseGate, createContractGate } from './release-gate.mjs';
import { validateVersion, validateInvocation } from './release-contract.mjs';
import { capturePublication } from './publication-content.mjs';
import { newRecovery, validateRecovery } from './publication-recovery.mjs';

function build(capabilities, mode, dependencies) {
  const { evidence, native, verifyConditions } = capabilities;
  if (!evidence || typeof evidence.load !== 'function' ||
      typeof evidence.save !== 'function' || !native ||
      typeof native.observe !== 'function' || typeof native.write !== 'function' ||
      typeof verifyConditions !== 'function') {
    throw new Error('CONFIGURATION: protected publication capabilities required');
  }
  const authorize = async plan => {
    validateInvocation(await capabilities.verifyInvocation(), capabilities.expected);
    if (await verifyConditions(structuredClone(plan.handoff)) !== true) {
      throw new Error('AUTHORIZATION: publication conditions unavailable');
    }
  };
  async function publish(record) {
    const completed = [];
    let current;
    let unresolved = false;
    const save = () => evidence.save(structuredClone(record));
    try {
      await authorize(record.plan);
      for (const repository of record.plan.repositories) {
        current = repository.id;
        const operations = [
          ...repository.objects.map((object, index) => ({
            key: `object-${index}`, ...object,
          })),
          { key: 'tag', kind: 'tag' },
          { key: 'release', kind: 'release' },
          ...repository.assets.map(asset => ({
            key: `asset-${asset.name}`, kind: 'asset', ...asset,
          })),
        ];
        for (const operation of operations) {
          const key = `${repository.id}/${operation.key}`;
          const previous = record.operations[key];
          const context = { repository, version: record.plan.handoff.version,
            operation, release: record.operations[`${repository.id}/release`]?.object };
          const observed = await native.observe(context);
          if (observed.state === 'unknown') {
            unresolved = true;
            throw new Error('PUBLICATION: native observation unresolved');
          }
          if (observed.state === 'matching') {
            // Immutable Git objects may predate this run. Visible publications may not.
            if (!previous && ['tag', 'release', 'asset'].includes(operation.kind)) {
              throw new Error('PUBLICATION: unowned existing object');
            }
            if (previous?.object &&
                JSON.stringify(previous.object) !== JSON.stringify(observed.object)) {
              throw new Error('PUBLICATION: native object identity changed');
            }
          } else if (observed.state === 'absent') {
            if (previous?.state === 'verified') {
              throw new Error('PUBLICATION: verified object disappeared');
            }
            await authorize(record.plan);
            record.operations[key] = { state: 'intent' };
            await save();
            // Any thrown/lost/malformed response is uncertain, never replay here.
            unresolved = true;
            await native.write(context);
            const readback = await native.observe(context);
            if (readback.state !== 'matching') {
              throw new Error('PUBLICATION: write not independently verified');
            }
            observed.object = readback.object;
            unresolved = false;
          } else {
            throw new Error('PUBLICATION: conflicting native object');
          }
          record.operations[key] = { state: 'verified', object: observed.object };
          await save();
        }
        completed.push(repository.id);
        record.completed = [...completed];
        await save();
      }
      return { outcome: 'published', mode, version: record.plan.handoff.version,
        completed, failed: [], unresolved: [] };
    } catch {
      return { outcome: 'blocked', mode, completed,
        failed: unresolved ? [] : [current ?? 'authorization'],
        unresolved: unresolved ? [current] : [],
        pending: record.plan.repositories.map(row => row.id)
          .filter(id => !completed.includes(id)) };
    }
  }
  return async function coordinate(inputs, { resume = false } = {}) {
    try {
      const version = validateVersion(inputs);
      validateInvocation(await capabilities.verifyInvocation(), capabilities.expected);
      const previous = await evidence.load(version);
      if (resume) return await publish(validateRecovery(previous, version, mode));
      if (previous !== null) throw new Error('RECOVERY: explicit resume required');
      let captured;
      const consumeRelease = async context => {
        captured = await (dependencies?.capture ?? capturePublication)(context);
      };
      const trusted = { ...capabilities, consumeRelease };
      const gate = mode === 'production' ? createReleaseGate(trusted) :
        createContractGate(trusted, dependencies);
      const result = await gate(inputs);
      if (result.outcome !== 'ready') return result;
      const record = newRecovery(captured);
      await evidence.save(structuredClone(record));
      return publish(record);
    } catch {
      return { outcome: 'blocked', reason: 'AUTHORIZATION_OR_RECOVERY_UNAVAILABLE' };
    }
  };
}

// Only protected release composition supplies these closures. No CLI/document seam.
export function createPublicationCoordinator(capabilities) {
  return build(capabilities, 'production');
}

// Controlled results explicitly remain contract-test results, never live proof.
export function createContractCoordinator(capabilities, dependencies) {
  return build(capabilities, 'contract-test', dependencies);
}
