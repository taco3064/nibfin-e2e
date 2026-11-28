import { equal } from 'node:assert/strict';
import { test } from 'node:test';
import { scenarios } from '../src/registry.ts';
import { scenarioGroups } from '../src/run.ts';

const groups = () =>
  scenarioGroups(scenarios)
    .map((g) => g.map((s) => s.id))
    .filter((g) => g.length > 1);

test('the scenarios that read only the observed-job facts start together, apart from their neighbours', () => {
  const ids = ['job-container', 'agent-setup', 'login-volume', 'project-tools', 'role-skills'];
  equal(
    groups().some((g) => g.join(' ') === ids.join(' ')),
    true,
    JSON.stringify(groups()),
  );
});

test('the two read-only site scenarios start together, apart from their neighbours', () => {
  equal(
    groups().some((g) => g.join(' ') === 'live-page site-deploy-on-push'),
    true,
    JSON.stringify(groups()),
  );
});

test('scenarios that stop Runners, change shared state or scan the whole sandbox stay out of every concurrent group', () => {
  for (const g of groups())
    for (const id of ['interrupted-deliver', 'model-choice', 'no-credentials', 'dashboard-serving', 'resolution-spec-fix'])
      equal(g.includes(id), false, `${id} is in the concurrent group ${g.join(', ')}`);
});
