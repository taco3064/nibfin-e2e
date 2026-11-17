import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { repositoryDefinition } from '../../repository-definition.mjs';
import { fixtureInventory } from '../../fixture-inventory.mjs';
import { sourceTerminationUnknown } from '../../source-process.mjs';

// This inventory owns only the selectable simulation, never an installed host.
export async function withManagedFixture(root, action) {
  const definition = repositoryDefinition({ id: 7, login: 'e2e-managed' },
    'e2e-managed/onboarding');
  const binding = { owner: definition.owner, hostId: `simulation-${randomUUID()}`,
    repositories: definition.repositories, memberId: definition.account.id };
  const inventory = await fixtureInventory(join(root, 'inventory'), definition,
    7, join(root, 'source'));
  return inventory.exclusive(async (state, save, retain) => {
    state.simulation = { ...binding, execution: 'pending' };
    await save();
    await writeFile(join(root, 'home', 'managed-fixture.json'),
      JSON.stringify(binding), { mode: 0o600 });
    try {
      const result = await action();
      state.simulation.execution = 'terminated';
      await save();
      return result;
    } catch (error) {
      if (sourceTerminationUnknown(error)) retain();
      throw error;
    }
  });
}
