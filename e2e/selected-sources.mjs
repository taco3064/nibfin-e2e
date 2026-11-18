import { join } from 'node:path';
import { acquireSource, sourceRepositories } from './source-checkout.mjs';
import { prepareProducer, verifyConsumerCompatibility } from './source-producers.mjs';
import { sourceClosure } from './source-requirements.mjs';
import { sourceTerminationUnknown } from './source-process.mjs';

export async function prepareSelected(options, context, sources) {
  const closure = sourceClosure(options.requirements);
  const availability = {};
  const attempt = async (id, dependencies, use) => {
    const failed = dependencies.find(key => !availability[key]?.available);
    try {
      if (failed) throw new Error(`${failed}: ${availability[failed]?.error}`);
      await use();
      availability[id] = Object.freeze({ available: true });
    } catch (error) {
      if (sourceTerminationUnknown(error)) throw error;
      availability[id] = Object.freeze({ available: false, error: String(error) });
    }
  };
  for (const repository of sourceRepositories) {
    const id = repository.id;
    const identity = id === 'cli' ? 'cli-source' : `${id}-source`;
    if (!closure.includes(id) && !closure.includes(identity)) continue;
    await attempt(identity, [], async () => {
      sources[id] = await acquireIdentity(repository, options, context);
    });
  }
  for (const id of ['core', 'action', 'cli']) {
    if (!closure.includes(id)) continue;
    const dependencies = [`${id}-source`];
    if (id !== 'core') dependencies.push('core');
    if (id === 'cli') dependencies.push('action-source');
    await attempt(id, dependencies, async () => {
      if (id !== 'core') {
        await verifyConsumerCompatibility(id, sources, sources.core.output);
      }
      const output = await (options.prepare ?? prepareProducer)(sources[id], context);
      if (!output || typeof output !== 'object') {
        throw new Error(`MISSING_PREPARED_OUTPUT: ${id}`);
      }
      sources[id] = Object.freeze({ ...sources[id], output: Object.freeze(output) });
    });
  }
  return Object.freeze(availability);
}

export async function acquireIdentity(repository, options, context) {
  const revision = options.selection?.[repository.id] ?? 'main';
  repository = { ...repository, revision };
  const checkout = join(context.root, repository.id);
  const commit = await (options.acquire ?? acquireSource)(
    repository, checkout, context,
  );
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`INVALID_CHECKOUT_IDENTITY: ${repository.repository}`);
  }
  return Object.freeze({ ...repository, checkout, commit });
}
