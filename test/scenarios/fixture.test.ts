import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { approvalRuleset, prepareFixture } from '../../scenarios/lib/fixture.ts';
import type { FixtureState } from '../../scenarios/lib/fixture.ts';
import { localRunners, runnerSlot } from '../../scenarios/lib/runners.ts';
import { createGitHub } from '../../src/host/github.ts';
import { EXEC, PEER, BASE_TREE, mainFiles, runner, setup } from './kit.ts';

test('runnerSlot reads the slot from the registration suffix only', () => {
  equal(runnerSlot('myhost-1a2b3c4d-claude-1'), 'claude-1');
  equal(runnerSlot('myhost-1a2b3c4d-claude-12'), 'claude-12');
  equal(runnerSlot('claude-1'), undefined);
  equal(runnerSlot('x-codex-1'), undefined);
  equal(runnerSlot('x-claude-0'), undefined);
});

test('localRunners resolves host-style names to both slots and fails on any other set, listing what it saw', async () => {
  const h = setup();
  deepEqual((await localRunners(h.kit.github, EXEC)).map((r) => [r.slot, r.name]), [['claude-1', 'myhost-1a2b3c4d-claude-1'], ['claude-2', 'myhost-1a2b3c4d-claude-2']]);
  const sets = {
    missing: [runner(1, 'claude-1')],
    third: [runner(1, 'claude-1'), runner(2, 'claude-2'), runner(3, 'claude-3')],
    duplicated: [runner(1, 'claude-1'), { ...runner(2, 'claude-1'), name: 'otherhost-99999999-claude-1' }],
    unmatched: [runner(1, 'claude-1'), { id: 2, name: 'claude-2', status: 'online', busy: false }],
  };
  for (const [what, list] of Object.entries(sets)) {
    h.repo(EXEC).runners = list;
    const err = await localRunners(h.kit.github, EXEC).catch((e: Error) => e.message);
    match(String(err), /expected exactly two runner registrations ending in -claude-1 and -claude-2; saw /, what);
    for (const r of list) ok(String(err).includes(r.name), `${what}: lists ${r.name}`);
  }
});

test('a busy or offline Runner stops prepareFixture before any write, naming its slot and registration', async () => {
  for (const state of [{ busy: true }, { status: 'offline' }]) {
    const h = setup();
    h.repo(EXEC).runners = [runner(1, 'claude-1'), runner(2, 'claude-2', state)];
    const err = await prepareFixture(h.kit, EXEC, { files: [] }).catch((e: Error) => e.message);
    match(String(err), /claude-2 \(registration myhost-1a2b3c4d-claude-2\) is (offline|online and busy)/);
    deepEqual(h.fake.writes, []);
  }
});

test('a dirty main is rebuilt from the baseline tree, committed on the current head and fast-forwarded', async () => {
  const h = setup();
  const r = h.repo(EXEC);
  h.fake.trees.set('dirty', new Map([...(h.fake.trees.get(BASE_TREE) ?? []), ['.nibfin.json', { mode: '100644', content: '{}' }], ['.rulesync/rules/x.md', { mode: '100644', content: 'x' }], ['e2e/probe.sh', { mode: '100644', content: 'x' }]]));
  r.commits.set('c9', { tree: 'dirty', parents: ['c0'] });
  r.branches.set('main', 'c9');
  await prepareFixture(h.kit, EXEC, { files: [{ path: '.nibfin/skills/a.md', content: 'A\n' }] });
  const head = r.branches.get('main') as string;
  deepEqual(r.commits.get(head)?.parents, ['c9']);
  deepEqual([...(mainFiles(h, EXEC)?.keys() ?? [])].sort(), ['.github/workflows/nibfin-issue.yml', '.nibfin/skills/a.md', 'README.md']);
  const treeWrite = h.fake.writes.filter((w) => w.endsWith('/git/trees'));
  equal(treeWrite.length, 1);
});

test('an already matching tree makes no commit; an empty fixture is the baseline itself', async () => {
  const h = setup();
  await prepareFixture(h.kit, EXEC, { files: [] });
  equal(h.fake.writes.length, 0);
  const state: FixtureState = { files: [{ path: 'a.txt', content: 'a\n' }] };
  await prepareFixture(h.kit, EXEC, state);
  const commits = h.fake.writes.filter((w) => w.endsWith('/git/commits')).length;
  await prepareFixture(h.kit, EXEC, state);
  equal(h.fake.writes.filter((w) => w.endsWith('/git/commits')).length, commits);
});

test('a symlink entry is written with mode 120000 and its target as content', async () => {
  const h = setup();
  await prepareFixture(h.kit, EXEC, { files: [{ path: '.nibfin/skills/escape.md', symlink: '/etc/passwd' }] });
  deepEqual(mainFiles(h, EXEC)?.get('.nibfin/skills/escape.md'), { mode: '120000', content: '/etc/passwd' });
});

test('a leftover e2e- pull-request ruleset is deleted before main is written; the fixture ruleset comes after the read-back', async () => {
  const h = setup();
  const r = h.repo(EXEC);
  (r.rulesets as { id: number; name: string; rules?: { type: string }[] }[]).push({ id: 7, name: 'e2e-approval', rules: [{ type: 'pull_request' }] }, { id: 8, name: 'owner-rule' });
  await prepareFixture(h.kit, EXEC, { files: [{ path: 'a.txt', content: 'a\n' }], ruleset: approvalRuleset() });
  const w = h.fake.writes;
  const del = w.indexOf(`DELETE /repos/${EXEC}/rulesets/7`);
  const ref = w.indexOf(`PATCH /repos/${EXEC}/git/refs/heads/main`);
  const create = w.indexOf(`POST /repos/${EXEC}/rulesets`);
  ok(del >= 0 && ref > del && create > ref, w.join('\n'));
  deepEqual((r.rulesets as { name: string }[]).map((x) => x.name), ['owner-rule', 'e2e-approval']);
  equal(w.includes(`DELETE /repos/${EXEC}/rulesets/8`), false);
});

test('a refused ref update fails with GitHub\'s message', async () => {
  const h = setup();
  h.fake.failures.set(`PATCH /repos/${EXEC}/git/refs/heads/main`, 422);
  await rejects(prepareFixture(h.kit, EXEC, { files: [{ path: 'a.txt', content: 'a\n' }] }), /refs\/heads\/main returned 422: refused by fake/);
});

test('the private peer: an "Upgrade to GitHub Pro" rules API means none; other 403s fail; a fixture ruleset is refused before any write', async () => {
  const h = setup({ peerRulesets: 'upgrade' });
  await prepareFixture(h.kit, PEER, { files: [{ path: 'a.txt', content: 'a\n' }] });
  equal(h.fake.writes.some((w) => w.includes('/rulesets')), false);
  const before = h.fake.writes.length;
  await rejects(prepareFixture(h.kit, PEER, { files: [], ruleset: approvalRuleset() }), /private peer sandbox has no rulesets/);
  equal(h.fake.writes.length, before);

  const other = setup();
  const original = other.fake.fetch;
  const gh = createGitHub(() => 'tok', async (input, init) =>
    new URL(String(input)).pathname === `/repos/${PEER}/rulesets` ? new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 }) : original(input, init),
  );
  await rejects(prepareFixture({ ...other.kit, github: gh }, PEER, { files: [] }), /rulesets returned 403: Resource not accessible by personal access token/);
});

test('preparing the peer reads the Runners from the execution sandbox only', async () => {
  const h = setup({ peerRulesets: 'upgrade' });
  await prepareFixture(h.kit, PEER, { files: [] });
  ok(h.fake.reads.includes(`/repos/${EXEC}/actions/runners`));
  equal(h.fake.reads.includes(`/repos/${PEER}/actions/runners`), false);
});

test('library variables converge to the fixture before the content write; other variables are kept', async () => {
  const h = setup();
  const r = h.repo(EXEC);
  r.variables.push('NIBFIN_CONTAINER_LIMITS', 'NIBFIN_MODEL', 'NIBFIN_INIT_OWNED');
  r.variableValues.set('NIBFIN_MODEL', 'opus');
  await prepareFixture(h.kit, EXEC, { files: [{ path: 'a.txt', content: 'a\n' }], variables: { NIBFIN_MODEL: 'haiku', NIBFIN_MEMORY: '1024g' } });
  deepEqual([...r.variables].sort(), ['NIBFIN_INIT_OWNED', 'NIBFIN_MEMORY', 'NIBFIN_MODEL']);
  deepEqual([r.variableValues.get('NIBFIN_MODEL'), r.variableValues.get('NIBFIN_MEMORY')], ['haiku', '1024g']);
  const w = h.fake.writes;
  ok(w.indexOf(`DELETE /repos/${EXEC}/actions/variables/NIBFIN_CONTAINER_LIMITS`) < w.indexOf(`PATCH /repos/${EXEC}/git/refs/heads/main`));
});

test('open Issues are closed as not planned; running Job containers are waited for on events', async () => {
  const h = setup({ respond: (argv) => (argv[1] === 'ps' ? { stdout: 'abc123\n' } : undefined) });
  h.repo(EXEC).issues.push({ number: 4, node_id: 'I4', state: 'open' }, { number: 5, node_id: 'I5', state: 'closed' });
  const done = prepareFixture(h.kit, EXEC, { files: [] });
  for (let i = 0; i < 50 && !h.calls.some((c) => c.argv[1] === 'ps'); i++) await new Promise((r) => setImmediate(r));
  h.events.emit(JSON.stringify({ Status: 'died', ID: 'abc123', Type: 'container' }));
  await done;
  deepEqual(h.repo(EXEC).issues.map((i) => [i.number, i.state, i.state_reason]), [[4, 'closed', 'not_planned'], [5, 'closed', undefined]]);
  const events = h.events.argvs[0] ?? [];
  ok(events.includes(`label=io.github.taco3064.nibfin.repo=${EXEC}`));
  equal(h.events.open, 0);
  const ps = h.calls.find((c) => c.argv[1] === 'ps');
  deepEqual(ps?.argv.slice(-2), ['--filter', `label=io.github.taco3064.nibfin.repo=${EXEC}`]);
});

test('order independence: each fixture gets the same writes and tree whichever ran before it', async () => {
  const a: FixtureState = { files: [{ path: '.nibfin.json', content: '{"tools":{}}\n' }], variables: { NIBFIN_MODEL: 'haiku' }, ruleset: approvalRuleset() };
  const b: FixtureState = { files: [], variables: { NIBFIN_CONTAINER_LIMITS: 'off' } };
  const result = async (order: FixtureState[]) => {
    const h = setup();
    const out: { writes: string[]; tree: string; vars: string[]; rulesets: string[] }[] = [];
    for (const s of order) {
      const start = h.fake.writes.length;
      const { tree } = await prepareFixture(h.kit, EXEC, s);
      const r = h.repo(EXEC);
      out.push({
        writes: h.fake.writes.slice(start),
        tree,
        vars: [...r.variables].sort().map((v) => `${v}=${r.variableValues.get(v)}`),
        rulesets: (r.rulesets as { name: string }[]).map((x) => x.name),
      });
    }
    return out;
  };
  const [ab, ba] = [await result([a, b]), await result([b, a])];
  const state = (x: (typeof ab)[number] | undefined) => [x?.tree, x?.vars, x?.rulesets];
  deepEqual(state(ab[1]), state(ba[0]));
  deepEqual(state(ab[0]), state(ba[1]));
  deepEqual(state(ab[1]), [BASE_TREE, ['NIBFIN_CONTAINER_LIMITS=off'], []]);
  // After a, b deletes a's ruleset before it writes the baseline back over a's content.
  const w = ab[1]?.writes ?? [];
  const del = w.findIndex((x) => x.startsWith(`DELETE /repos/${EXEC}/rulesets/`));
  ok(del >= 0 && del < w.indexOf(`PATCH /repos/${EXEC}/git/refs/heads/main`), w.join('\n'));
});
