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
  // A fake clock: sleep advances now at once, so a wait passes no real time.
  const clock = { t: 0, sleeps: 0 };
  const logs: string[] = [];
  const deps = {
    github,
    template,
    log: (m: string) => void logs.push(m),
    now: () => clock.t,
    sleep: async (ms: number) => void ((clock.t += ms), clock.sleeps++),
  };
  return { fake, repo: fake.repos.get('o/exec') as ReturnType<typeof cleanRepo>, deps, clock, logs };
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
  equal(
    fake.auth.every((a) => a === 'Bearer tok'),
    true,
  );
  equal(
    fake.urls.some((u) => u.includes('tok')),
    false,
  );
});

test('a dirty sandbox is converged: everything deleted, settings fixed, main fast-forwarded to the template', async () => {
  const { fake, repo, deps } = setup();
  Object.assign(repo.settings, {
    visibility: 'private',
    allow_squash_merge: false,
    delete_branch_on_merge: true,
    pull_request_creation_policy: 'all',
  });
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
  deepEqual(
    [repo.issues, repo.labels, repo.secrets, repo.variables, repo.keys, repo.runners, repo.rulesets],
    [[], [], [], [], [], [], []],
  );
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

test('a public sandbox with branch protection on main is reset before the template commit and reads back clean', async () => {
  const { fake, repo, deps } = setup();
  repo.protection = {
    required_status_checks: { strict: true, contexts: ['x'] },
    required_linear_history: { enabled: true },
  };
  repo.commits.set('c0', { tree: 'old', parents: [] });
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), []);
  equal(repo.protection, undefined);
  const del = fake.writes.indexOf('DELETE /repos/o/exec/branches/main/protection');
  const commit = fake.writes.indexOf('PATCH /repos/o/exec/git/refs/heads/main');
  equal(del >= 0 && commit > del, true, fake.writes.join(', '));
});

test('a private peer whose branch protection answers "Upgrade to GitHub Pro" gets no write and reads back clean', async () => {
  const { fake, repo, deps } = setup('private');
  repo.rulesets = 'upgrade';
  repo.protection = 'upgrade';
  deepEqual(await resetSandbox(deps, 'o/exec', 'private'), []);
  deepEqual(fake.writes, []);
});

test('a branch protection DELETE that does not stick is reported by the read-back', async () => {
  const { fake, repo, deps } = setup();
  repo.protection = { required_linear_history: { enabled: true } };
  fake.failures.set('DELETE /repos/o/exec/branches/main/protection', 204);
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), ['o/exec: branch main has branch protection']);
});

test("any other 403 on branch protection fails with GitHub's message", async () => {
  const { fake, deps } = setup();
  fake.failures.set('GET /repos/o/exec/branches/main/protection', 403);
  await rejects(resetSandbox(deps, 'o/exec', 'public'), /branches\/main\/protection returned 403: refused by fake/);
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
  await rejects(
    resetSandbox(deps, 'o/exec', 'public'),
    /DELETE \/repos\/o\/exec\/keys\/1 returned 403: refused by fake/,
  );
});

test('setVisibility reads the visibility back', async () => {
  const { fake, repo, deps } = setup();
  await setVisibility(deps.github, 'o/exec', 'private');
  equal(repo.settings.visibility, 'private');
  fake.failures.set('PATCH /repos/o/exec', 200);
  await rejects(setVisibility(deps.github, 'o/exec', 'public'), /reads back private, expected public/);
});

function context(fake: FakeGitHub) {
  const services = {
    github: createGitHub(() => 'tok', fake.fetch),
    exec: fakeExec().exec,
    repoRoot: '/tmp/x',
    sandboxToken: () => 'tok',
  } as unknown as HostServices;
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
  await rejects(
    ctx.withExecutionVisibility('private', async () => {
      throw new Error('scenario broke');
    }),
    /scenario broke/,
  );
  equal(repo.settings.visibility, 'public');
});

test('a failed restore fails the scenario and names both causes', async () => {
  const fake = new FakeGitHub();
  fake.repos.set('taco3064/nibfin-e2e-sandbox', cleanRepo('public', tree));
  let calls = 0;
  const original = fake.fetch;
  fake.fetch = async (input, init) => {
    if (init?.method === 'PATCH' && ++calls === 2)
      return new Response(JSON.stringify({ message: 'nope' }), { status: 500 });
    return original(input, init);
  };
  const ctx = context(fake);
  const err = await ctx
    .withExecutionVisibility('private', async () => {
      throw new Error('inner');
    })
    .catch((e: Error) => e);
  match(
    String(err),
    /restoring taco3064\/nibfin-e2e-sandbox to public failed: .*500: nope; the scenario had also failed: inner/,
  );
});

test('a leftover tag that does not delete is reported by the read-back', async () => {
  const { fake, repo, deps } = setup();
  repo.tags.push('r1-a-ci2');
  fake.failures.set('DELETE /repos/o/exec/git/refs/tags/r1-a-ci2', 204);
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), ['o/exec: tag r1-a-ci2 exists']);
});

const GITHUB_BUSY = 'Bad request - Runner host-claude-1 is currently running a job and cannot be deleted.';

test('an in-progress run is cancelled before its busy runner is deleted, and the sandbox reads back clean', async () => {
  const { fake, repo, deps, clock, logs } = setup();
  repo.runs.push({ id: 41, name: 'Nibfin', status: 'in_progress' });
  repo.runners.push({ id: 61, name: 'host-claude-1', status: 'offline', busy: true });
  fake.onCancel = (r, id) => {
    const run = r.runs.find((x) => x.id === id);
    if (run) run.status = 'completed';
    for (const rn of r.runners) rn.busy = false;
  };
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), []);
  deepEqual(repo.runners, []);
  const cancel = fake.writes.indexOf('POST /repos/o/exec/actions/runs/41/cancel');
  const del = fake.writes.indexOf('DELETE /repos/o/exec/actions/runners/61');
  equal(cancel >= 0 && del > cancel, true, fake.writes.join(', '));
  equal(
    fake.writes.some((w) => w.includes('force-cancel')),
    false,
  );
  equal(clock.sleeps, 1);
  deepEqual(logs, [
    'o/exec: cancel requested for workflow run 41 (Nibfin, in_progress)',
    'o/exec: waited 10s for runner(s) host-claude-1 to be released; released',
  ]);
});

test('a runner that stays busy fails within the wait limit, naming the runner, its job, the cancels and the next step', async () => {
  const { fake, repo, deps, clock, logs } = setup();
  repo.runs.push({
    id: 41,
    name: 'Nibfin',
    status: 'in_progress',
    jobs: [
      {
        name: 'route',
        status: 'completed',
        runner_name: 'other',
        html_url: 'https://github.com/o/exec/actions/runs/41/job/1',
      },
      {
        name: 'review',
        status: 'in_progress',
        runner_name: 'host-claude-1',
        html_url: 'https://github.com/o/exec/actions/runs/41/job/2',
      },
    ],
  });
  repo.runners.push(
    { id: 61, name: 'host-claude-1', status: 'offline', busy: true },
    { id: 62, name: 'idle', status: 'offline', busy: false },
  );
  const err = (await resetSandbox(deps, 'o/exec', 'public').catch((e: unknown) => e)) as Error;
  equal(err instanceof Error, true);
  const m = err.message;
  match(m, /o\/exec: runner registration host-claude-1 \(id 61\) could not be deleted/);
  equal(m.includes(`GitHub DELETE /repos/o/exec/actions/runners/61 returned 422: ${GITHUB_BUSY}`), true, m);
  match(
    m,
    /held by job "review" \(https:\/\/github\.com\/o\/exec\/actions\/runs\/41\/job\/2\) of workflow run 41 \(Nibfin\)/,
  );
  match(m, /cancel requested for runs 41; force-cancel for 41/);
  match(m, /waited 360s of 360s/);
  match(
    m,
    /the runner must finish its job, or its job must be cancelled or the runner released on GitHub, before the sandboxes can be reset; then rerun the sandboxes step/,
  );
  match(String((err.cause as Error).message), /returned 422: Bad request - Runner host-claude-1/);
  equal((err.cause as { status?: number }).status, 422);
  // The idle registration is still deleted; the busy one is kept.
  deepEqual(
    repo.runners.map((r) => r.id),
    [61],
  );
  equal(clock.t <= 360_000 + 10_000, true);
  equal(fake.writes.filter((w) => w === 'POST /repos/o/exec/actions/runs/41/force-cancel').length, 1);
  deepEqual(logs, [
    'o/exec: cancel requested for workflow run 41 (Nibfin, in_progress)',
    'o/exec: force-cancel requested for workflow run 41 (Nibfin, in_progress)',
    'o/exec: waited 360s for runner(s) host-claude-1 to be released; still busy: host-claude-1',
  ]);
});

test('a runner refused with no in-progress job of the repository says so', async () => {
  const { repo, deps } = setup();
  repo.runners.push({ id: 61, name: 'host-claude-1', status: 'offline', busy: true });
  await rejects(
    resetSandbox(deps, 'o/exec', 'public'),
    /no in-progress job of this repository names it; cancel requested for runs none; force-cancel for none; waited 360s/,
  );
});

test('completed runs are not cancelled and an idle runner is deleted without waiting', async () => {
  const { fake, repo, deps, clock } = setup();
  repo.runs.push({ id: 40, name: 'Nibfin', status: 'completed' });
  repo.runners.push({ id: 9, name: 'idle', status: 'offline', busy: false });
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), []);
  deepEqual(fake.writes, ['DELETE /repos/o/exec/actions/runners/9']);
  equal(clock.sleeps, 0);
});

test('a run that finished before its cancel arrives (409) is accepted and logged', async () => {
  const { fake, repo, deps, logs } = setup();
  repo.runs.push({ id: 42, name: 'Nibfin', status: 'queued' });
  fake.failures.set('POST /repos/o/exec/actions/runs/42/cancel', 409);
  deepEqual(await resetSandbox(deps, 'o/exec', 'public'), []);
  deepEqual(logs, [
    'o/exec: cancel requested for workflow run 42 (Nibfin, queued); GitHub answered 409: refused by fake',
  ]);
});
