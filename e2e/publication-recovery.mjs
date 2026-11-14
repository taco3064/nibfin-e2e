import { digest } from './publication-content.mjs';
import { validateHandoff } from './release-contract.mjs';

export const contentIdentity = plan => digest(Buffer.from(JSON.stringify(plan)));

export function newRecovery(plan) {
  validateHandoff(plan.handoff);
  return { schemaVersion: 1, plan: structuredClone(plan),
    identity: contentIdentity(plan), operations: {}, completed: [] };
}

// Evidence is loaded only through protected Actions composition, never request input.
export function validateRecovery(record, version, mode) {
  if (!record || record.schemaVersion !== 1 ||
      record.identity !== contentIdentity(record.plan) ||
      record.plan.handoff.version !== version || record.plan.handoff.mode !== mode ||
      !record.operations || !Array.isArray(record.completed)) {
    throw new Error('RECOVERY: missing or inconsistent evidence');
  }
  validateHandoff(record.plan.handoff);
  const sources = record.plan.handoff.sources;
  if (!Array.isArray(record.plan.repositories) ||
      record.plan.repositories.length !== sources.length) {
    throw new Error('RECOVERY: source set changed');
  }
  sources.forEach((source, index) => {
    const row = record.plan.repositories[index];
    if (Object.keys(source).some(key => source[key] !== row[key]) ||
        !/^[a-f0-9]{40}$/.test(row.target) || !Array.isArray(row.objects) ||
        !Array.isArray(row.assets) || row.assets.some(asset =>
          digest(Buffer.from(asset.content, 'base64')) !== asset.sha256)) {
      throw new Error('RECOVERY: content changed');
    }
  });
  const operationKeys = new Set(record.plan.repositories.flatMap(row => [
    ...row.objects.map((_, index) => `${row.id}/object-${index}`),
    `${row.id}/tag`, `${row.id}/release`,
    ...row.assets.map(asset => `${row.id}/asset-${asset.name}`),
  ]));
  for (const [key, operation] of Object.entries(record.operations)) {
    if (!operationKeys.has(key) || !operation ||
        !['intent', 'verified'].includes(operation.state) ||
        Object.keys(operation).sort().join(',') !==
          (operation.state === 'intent' ? 'state' : 'object,state') ||
        (operation.state === 'verified' &&
          (!operation.object || typeof operation.object !== 'object'))) {
      throw new Error('RECOVERY: inconsistent operation evidence');
    }
  }
  const ordered = record.plan.repositories.map(row => row.id);
  if (record.completed.some((id, index) => id !== ordered[index])) {
    throw new Error('RECOVERY: inconsistent completion evidence');
  }
  return record;
}
