import { mkdtemp, mkdir, readFile, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSource, sourceEnvironment, sourceRepositories,
} from './source-checkout.mjs';
import { sourceCommand, sourceTerminationUnknown } from './source-process.mjs';

// Acquisition owns only this temporary checkout. It is never the installed Core.
export async function withScopeSource(use) {
  const root = await mkdtemp(join(tmpdir(), 'defect-scope-'));
  let unknown = false;
  let revision = null;
  let stage = 'acquisition';
  try {
    const home = join(root, 'home');
    await mkdir(home);
    const checkout = join(root, 'core');
    const core = sourceRepositories.find(row => row.id === 'core');
    revision = await acquireSource(core, checkout, { root,
      env: { ...sourceEnvironment(root), HOME: home },
      command: (file, args, options) => sourceCommand(file, args,
        { ...options, timeoutMs: 120000, limit: 1024 * 1024 }),
    });
    stage = 'skill';
    const path = join(checkout, 'skills', 'scope', 'SKILL.md');
    if (!((await realpath(path)).startsWith(`${checkout}/`))) {
      throw new Error('SCOPE_SKILL_UNAVAILABLE');
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 128 * 1024) {
      throw new Error('SCOPE_SKILL_UNAVAILABLE');
    }
    const skill = await readFile(path, 'utf8');
    if (!skill.trim()) throw new Error('SCOPE_SKILL_UNAVAILABLE');
    stage = 'investigation';
    return await use({ revision, skill, checkout });
  } catch (error) {
    unknown = sourceTerminationUnknown(error);
    // These fixed fields cross the public boundary; raw errors never do.
    const failure = new Error('SCOPE_SOURCE_UNRESOLVED', { cause: error });
    failure.scopeRevision = revision;
    failure.investigationReason = unknown ? 'SOURCE_TERMINATION_UNKNOWN' :
      stage === 'skill' ? 'SCOPE_SKILL_UNAVAILABLE' :
        stage === 'acquisition' ? 'OFFICIAL_SOURCE_UNAVAILABLE' :
          'INVESTIGATION_UNRESOLVED';
    throw failure;
  } finally {
    if (!unknown) await rm(root, { recursive: true, force: true });
  }
}
