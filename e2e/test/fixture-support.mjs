import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureDefinition } from '../fixture-definition.mjs';
import { fixtureInventory } from '../fixture-inventory.mjs';
import { fixtureLifecycle } from '../fixture-lifecycle.mjs';

export const sha = 'a'.repeat(40);
export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = fixtureDefinition('controlled-delivery');
  const inventory = await fixtureInventory(join(root, 'ledger'), definition, 7,
    join(root, 'worker'));
  const resources = new Map();
  const writes = [];
  let sequence = 100;
  const native = record => {
    if (record.kind === 'branch') return {
      ref: record.payload.ref, object: { sha: record.payload.sha }, merged: false,
      url: `https://api.github.com/repos/${definition.repository}/` +
        `git/refs/heads/${definition.name}`,
    };
    const number = ++sequence;
    return { id: number + 1000, number, user: { id: 7 }, state: 'open',
      body: record.payload.body, merged: false,
      head: { ref: definition.name, repo: { full_name: definition.repository } },
      url: `https://api.github.com/repos/${definition.repository}/` +
        `${record.kind === 'issue' ? 'issues' : 'pulls'}/${number}` };
  };
  const key = record => record.kind === 'branch' ? definition.name : record.native.id;
  const api = {
    preflight: async () => 7,
    beforeCreate: async () => {},
    create: async record => {
      const result = native(record);
      resources.set(record.kind === 'branch' ? definition.name : result.id, result);
      writes.push(['create', record.kind]);
      options.created?.(record, result);
      return structuredClone(result);
    },
    read: async record => structuredClone(resources.get(key(record)) ?? { absent: true }),
    cleanup: async record => {
      writes.push(['cleanup', record.kind]);
      if (record.kind === 'branch') resources.delete(key(record));
      else resources.get(key(record)).state = 'closed';
    },
  };
  const context = { authorize: async () => true, idle: async () => true };
  const lifecycle = () => fixtureLifecycle({ inventory, provider: () => api, context,
    bounds: { timeoutMs: 1000, requestTimeoutMs: 100, ...options.bounds } });
  return { root, definition, inventory, resources, writes, api, context, lifecycle };
}
