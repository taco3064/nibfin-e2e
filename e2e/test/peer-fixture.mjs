import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installationFixture } from './installation-fixture.mjs';
import { peerTemplates, blob } from '../peer-observations.mjs';
import { protectedPeerEnrollment } from '../peer-protected.mjs';

export async function enrollmentFixture(t) {
  const f = await installationFixture(t);
  await f.driver().install();
  const core = f.sources.core.checkout;
  await mkdir(join(core, 'src'), { recursive: true });
  await mkdir(join(core, '.github/workflows'), { recursive: true });
  // Deliberately synthetic producer API. Production imports its prepared Core.
  await writeFile(join(core, 'src/caller-recipes.mjs'), [
    'export function callerRecipe(kind, commit, action = {}) {',
    '  return JSON.stringify({ kind, commit, action });',
    '}',
  ].join('\n'));
  await writeFile(join(core, 'src/shared-runner-contract.json'), JSON.stringify({
    workflowPath: '.github/workflows/shared-runner.yml',
  }));
  await writeFile(join(core, '.github/workflows/shared-runner.yml'),
    'synthetic shared workflow\n');
  const templates = await peerTemplates({ ...f.sources, memberId: 9 });
  const repositories = (await f.read()).repositories;
  const binding = { ...f.binding, repository: repositories[1].repository,
    repositoryId: repositories[1].native.id,
    runRepository: f.binding.repository, runRepositoryId: f.binding.repositoryId };
  const raw = { binding, sources: f.sources, authenticatedMemberId: 9,
    registrations: { complete: true, repository: binding.repository,
      repositoryId: binding.repositoryId, runners: [] },
    executionRunners: f.observation.runners, executionRegistrationsComplete: true,
    adopted: false, callers: Object.fromEntries(Object.entries(templates).map(
      ([key, template], i) => {
        const repository = key === 'execution' ? binding.runRepository :
          binding.repository;
        return [key, { ...template, repository,
          repositoryId: key === 'execution' ? 7 : 8, workflowId: 100 + i,
          sourceCommit: 'c'.repeat(40), branch: 'main',
          ref: `${repository}/${template.path}@refs/heads/main`,
          blob: blob(template.content), active: true, complete: true }];
      })),
  };
  let adoptions = 0;
  const context = { origin: 'synthetic', binding,
    authorize: async () => true,
    observe: async () => structuredClone(raw),
    adopt: async () => { adoptions++; raw.adopted = true; },
    reconcile: async () => ({ terminated: true, effects: 'reconciled' }),
  };
  return { ...f, raw, peerContext: context, peerBinding: binding,
    adoptions: () => adoptions,
    peer: bounds => protectedPeerEnrollment({ sources: f.sources,
      inventory: f.inventory, context, bounds }),
  };
}
