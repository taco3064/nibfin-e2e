import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireSource, sourceEnvironment, sourceRepositories,
} from './source-checkout.mjs';
import { prepareProducer, verifyCompatibility } from './source-producers.mjs';

// A set is returned only after every operation and compatibility check succeeds.
// Its owner keeps it across scenarios and release preparation, then disposes it.
export async function prepareSources(options = {}) {
  const root = await mkdtemp(join(resolve(options.tempRoot ?? tmpdir()),
    'nibfin-sources-'));
  const remove = options.remove ?? rm;
  const context = {
    root, command: options.command, diagnostic: options.diagnostic,
    env: { ...sourceEnvironment(root), HOME: join(root, 'home') },
  };
  const sources = {};
  try {
    await mkdir(context.env.HOME);
    for (const repository of sourceRepositories) {
      const checkout = join(root, repository.id);
      const commit = await (options.acquire ?? acquireSource)(
        repository, checkout, context,
      );
      if (!/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error(`INVALID_CHECKOUT_IDENTITY: ${repository.repository}`);
      }
      sources[repository.id] = Object.freeze({ ...repository, commit, checkout });
    }
    const prepare = options.prepare ?? prepareProducer;
    const coreOutput = await prepare(sources.core, context);
    await verifyCompatibility(sources, coreOutput);
    const outputs = {
      core: coreOutput,
      action: await prepare(sources.action, context),
      cli: await prepare(sources.cli, context),
    };
    for (const [id, source] of Object.entries(sources)) {
      if (!outputs[id] || typeof outputs[id] !== 'object') {
        throw new Error(`MISSING_PREPARED_OUTPUT: ${id}`);
      }
      sources[id] = Object.freeze({ ...source, output: Object.freeze(outputs[id]) });
    }
  } catch (error) {
    try { await remove(root, { recursive: true, force: true }); }
    catch (cleanup) {
      throw new AggregateError([error, cleanup],
        `SOURCE_CLEANUP_ERROR: retained ${root}; ${error}; ${cleanup}`);
    }
    throw new Error(`SOURCE_PREPARATION_ERROR: ${error}`, { cause: error });
  }
  let disposed = false;
  let disposing;
  return Object.freeze({
    root, sources: Object.freeze(sources),
    get disposed() { return disposed; },
    async dispose() {
      if (disposed) return;
      disposing ??= Promise.resolve().then(() =>
        remove(root, { recursive: true, force: true }),
      ).then(() => {
        disposed = true;
      }).catch(error => {
        disposing = undefined;
        throw new Error(`SOURCE_CLEANUP_ERROR: retained ${root}; ${error}`,
          { cause: error });
      });
      await disposing;
    },
  });
}

export async function withPreparedSources(use, options = {}) {
  const prepared = await prepareSources(options);
  let value;
  let failure;
  let failed = false;
  try { value = await use(prepared); }
  catch (error) { failure = error; failed = true; }
  try { await prepared.dispose(); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], `${failure}; ${error}`);
    throw error;
  }
  if (failed) throw failure;
  return value;
}
