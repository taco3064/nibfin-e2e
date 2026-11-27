import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHostContext } from '../../src/host/context.ts';
import { createGitHub } from '../../src/host/github.ts';
import { planHasNoRulesets, readTemplate, resetSandbox, setVisibility, treeSha } from '../../src/host/sandbox.ts';
import type { HostServices } from '../../src/host/services.ts';
import { FakeGitHub, cleanRepo, fakeExec } from './fakes.ts';

const template = readTemplate(join(import.meta.dirname, '..', '..', 'sandbox-template'));
const tree = treeSha(template);

function setup(visibility = 'public') {
  const fake = new FakeGitHub();
  fake.repos.set('o/exec', cleanRepo(visibility, tree));
  const github = createGitHub(() => 'tok', fake.fetch);
  return { fake, repo: fake.repos.get('o/exec') as ReturnType<typeof cleanRepo>, deps: { github, template, log: () => {} } };
}

test('treeSha matches git write-tree, including the order of d.txt and d/', () => {
  const files = [
    { path: 'a.txt', content: Buffer.from('a\n') },
    { path: 'd.txt', content: Buffer.from('c\n') },
    { path: 'd/b.txt', content: Buffer.from('b\n') },
  ];
  equal(treeSha(files), '474b715739874d6b8a581c27db9521f6f8cb6189');
  deepEqual(template.map((f) => f.path).includes('.github/workflows/ci.yml'), true);
});

test('an already clean sandbox gets no write and reads back clean', async () => {
  const { fake, deps } = setup();
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), []);
  deepEqual(fake.writes, []);
  equal(fake.auth.every((a) => a === 'Bearer tok'), true);
  equal(fake.urls.some((u) => u.includes('tok')), false);
});

test('a dirty sandbox is converged: everything deleted, settings fixed, main fast-forwarded to the template', async () => {
  const { fake, repo, deps } = setup();
  Object.assign(repo.settings, { visibility: 'private', allow_squash_merge: false, delete_branch_on_merge: true, pull_request_creation_policy: 'all' });
  repo.commits.set('c0', { tree: 'old', parents: [] });
  repo.branches.set('nibfin/issue-1', 'c0');
  repo.pulls.push({ number: 2, state: 'open', head: { sha: 'c0' } });
  repo.issues.push({ number: 1, node_id: 'I1' });
  repo.labels.push('scope', 'nibfin-1');
  repo.secrets.push('NIBFIN_GITHUB_TOKEN');
  repo.variables.push('NIBFIN_X');
  repo.keys.push({ id: 7, title: 'hook' });
  repo.runners.push({ id: 9, name: 'old', status: 'offline' });
  repo.rulesets = [{ id: 3, name: 'main' }];
  repo.tags.push('r1-a-cd', 'nested/tag');

  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), []);
  deepEqual(repo.tags, []);
  equal(fake.writes.includes('DELETE /repos/o/exec/git/refs/tags/nested/tag'), true);
  equal(repo.settings.visibility, 'public');
  equal(repo.settings.pull_request_creation_policy, 'collaborators_only');
  deepEqual([...repo.branches.keys()], ['main']);
  const head = repo.branches.get('main') as string;
  deepEqual(repo.commits.get(head), { tree, parents: ['c0'] });
  deepEqual([repo.issues, repo.labels, repo.secrets, repo.variables, repo.keys, repo.runners, repo.rulesets], [[], [], [], [], [], [], []]);
  equal(repo.pulls[0]?.state, 'closed');
  equal(fake.writes.includes('PATCH /repos/o/exec/git/refs/heads/main'), true);
  equal(fake.writes.includes('POST /graphql'), true);
});

test('a private peer whose rules API answers "Upgrade to GitHub Pro" has no rulesets', async () => {
  const { fake, repo, deps } = setup('private');
  repo.rulesets = 'upgrade';
  deepEqual(await resetSandbox(deps, 'o/exec', 'private'), []);
  deepEqual(fake.writes, []);
});

test('only the "Upgrade to GitHub Pro" 403 means a plan without rulesets', () => {
  equal(planHasNoRulesets('Upgrade to GitHub Pro or make this repository public to enable this feature.'), true);
  equal(planHasNoRulesets('Resource not accessible by integration'), false);
  equal(planHasNoRulesets(''), false);
});

test('a write that does not stick is reported by the read-back', async () => {
  const { fake, repo, deps } = setup();
  repo.labels.push('scope');
  repo.settings.visibility = 'private';
  fake.failures.set('DELETE /repos/o/exec/labels/scope', 204);
  fake.failures.set('PATCH /repos/o/exec', 200);
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), [
    'o/exec: visibility is "private", expected "public"',
    'o/exec: label scope exists',
  ]);
});

test('a GitHub refusal fails with its message', async () => {
  const { fake, repo, deps } = setup();
  repo.keys.push({ id: 1, title: 'k' });
  fake.failures.set('DELETE /repos/o/exec/keys/1', 403);
  await rejects(resetSandbox(deps, 'o/exec', 'public'), /DELETE \/repos\/o\/exec\/keys\/1 returned 403: refused by fake/);
});

test('setVisibility reads the visibility back', async () => {
  const { fake, repo, deps } = setup();
  await setVisibility(deps.github, 'o/exec', 'private');
  equal(repo.settings.visibility, 'private');
  fake.failures.set('PATCH /repos/o/exec', 200);
  await rejects(setVisibility(deps.github, 'o/exec', 'public'), /reads back private, expected public/);
});

function context(fake: FakeGitHub) {
  const services = { github: createGitHub(() => 'tok', fake.fetch), exec: fakeExec().exec, repoRoot: '/tmp/x', sandboxToken: () => 'tok' } as unknown as HostServices;
  return createHostContext(services);
}

test('withExecutionVisibility runs fn private and restores public, also after a throw', async () => {
  const fake = new FakeGitHub();
  fake.repos.set('taco3064/nibfin-e2e-sandbox', cleanRepo('public', tree));
  const repo = fake.repos.get('taco3064/nibfin-e2e-sandbox') as ReturnType<typeof cleanRepo>;
  const ctx = context(fake);
  let seen = '';
  equal(await ctx.withExecutionVisibility('private', async () => ((seen = String(repo.settings.visibility)), 42)), 42);
  equal(seen, 'private');
  equal(repo.settings.visibility, 'public');
  await rejects(ctx.withExecutionVisibility('private', async () => { throw new Error('scenario broke'); }), /scenario broke/);
  equal(repo.settings.visibility, 'public');
});

test('a failed restore fails the scenario and names both causes', async () => {
  const fake = new FakeGitHub();
  fake.repos.set('taco3064/nibfin-e2e-sandbox', cleanRepo('public', tree));
  let calls = 0;
  const original = fake.fetch;
  fake.fetch = async (input, init) => {
    if (init?.method === 'PATCH' && ++calls === 2) return new Response(JSON.stringify({ message: 'nope' }), { status: 500 });
    return original(input, init);
  };
  const ctx = context(fake);
  const err = await ctx.withExecutionVisibility('private', async () => { throw new Error('inner'); }).catch((e: Error) => e);
  match(String(err), /restoring taco3064\/nibfin-e2e-sandbox to public failed: .*500: nope; the scenario had also failed: inner/);
});

test('a leftover tag that does not delete is reported by the read-back', async () => {
  const { fake, repo, deps } = setup();
  repo.tags.push('r1-a-ci2');
  fake.failures.set('DELETE /repos/o/exec/git/refs/tags/r1-a-ci2', 204);
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), ['o/exec: tag r1-a-ci2 exists']);
});
