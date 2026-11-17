import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSource, sourceEnvironment, sourceRepositories,
} from './source-checkout.mjs';
import { sourceTerminationUnknown } from './source-process.mjs';

// Verification owns only its acquired Core component source. Existing prepared
// inputs remain owned by their caller; no producer declarations are rewritten.
export async function withVerificationCore(use, options = {}) {
  const env = options.env ?? process.env;
  const checkout = env.NIBFIN_TEST_CORE;
  const commit = env.NIBFIN_TEST_CORE_COMMIT;
  if (checkout || commit) {
    if (!checkout || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
      throw new Error('PREPARED_CORE_INPUTS_INCOMPLETE');
    }
    return use(env);
  }
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'verify-core-'));
  let unknown = false;
  try {
    const home = join(root, 'home');
    await mkdir(home);
    const source = sourceRepositories.find(source => source.id === 'core');
    const path = join(root, 'core');
    const identity = await (options.acquire ?? acquireSource)(source, path, {
      root, env: { ...sourceEnvironment(root), HOME: home },
    });
    if (!/^[a-f0-9]{40}$/.test(identity)) {
      throw new Error('INVALID_CHECKOUT_IDENTITY');
    }
    return await use({ ...env, NIBFIN_TEST_CORE: path,
      NIBFIN_TEST_CORE_COMMIT: identity });
  } catch (error) {
    unknown = sourceTerminationUnknown(error);
    throw error;
  } finally {
    if (!unknown) await rm(root, { recursive: true, force: true });
  }
}
