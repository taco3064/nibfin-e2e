import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, select } from '../registry.mjs';

const groups = {
  'wake-contract': ['wake.shared-issue.fixture', 'wake.action.fixture'],
  'isolation.local': ['isolation.local'],
  'isolation.host': [
    'isolation.host.host-path', 'isolation.host.credential',
    'isolation.host.role-write', 'isolation.host.network',
  ],
  runner: ['cli.runner-contract'],
  delivery: ['delivery.live'],
  dependency: ['dependency.live'],
};

test('maintained registry preserves each scenario and group selection', () => {
  assert.deepEqual(select(scenarios).map(row => row.id),
    Object.values(groups).flat().sort());
  for (const [group, ids] of Object.entries(groups)) {
    assert.deepEqual(select(scenarios, [group]).map(row => row.id), [...ids].sort());
  }
  assert.deepEqual(select(scenarios, Object.keys(groups)), select(scenarios));
});
