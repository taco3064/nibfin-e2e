import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryDefinition } from '../repository-definition.mjs';
import { simulatedProvider, simulatedAccount } from '../simulated-provider.mjs';
import { simulatedContexts } from '../simulated-contexts.mjs';
import { protectedRunTeardown } from '../run-teardown.mjs';

for (const uncertain of ['execution', 'effects']) {
  test(`unknown ${uncertain} prevents teardown and retains inventory ownership`,
    async () => {
      const definition = repositoryDefinition(simulatedAccount, 'simulated/source');
      const provider = simulatedProvider(definition);
      provider.create({ repository: definition.repositories[0] });
      provider.begin();
      if (uncertain === 'effects') provider.end(false);
      const { teardown } = simulatedContexts(provider, { sources: {} }, () => {});
      const state = { definition, actor: simulatedAccount.id, resources: [] };
      let retained = false;
      const inventory = { path: 'in-memory',
        exclusive: action => action(state, async () => {}, () => { retained = true; }),
      };
      const result = await protectedRunTeardown({ inventory,
        context: teardown.context }).teardown();
      assert.equal(result.state, 'unresolved');
      assert.equal(result.phase, 'execution');
      assert.equal(retained, true);
      assert.equal(provider.repositories.size, 1);
      assert.equal(provider.revoked, false);
      assert.equal(provider.settled, false);
    });
}
