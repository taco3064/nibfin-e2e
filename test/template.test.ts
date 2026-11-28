import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

type Git = (args: string[]) => { code: number; stdout: string; stderr?: string };
interface Hook {
  HOLD_LIMIT_MS: number;
  evaluate(
    env: Record<string, string | undefined>,
    deps?: {
      git?: Git;
      readFile?: (f: string) => string;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      log?: (m: string) => void;
    },
  ): Promise<string[]>;
}

const root = join(import.meta.dirname, '..', 'sandbox-template');
const hook = (await import(pathToFileURL(join(root, 'scripts', 'e2e-hook.js')).href)) as Hook;

/** A fake git: `diff` answers the changed paths and records its args; `ls-remote` answers whether the tag exists. */
function fakeGit(changed: string[], tagAfter = Infinity) {
  const calls: string[][] = [];
  let lsRemote = 0;
  const git: Git = (args) => {
    calls.push(args);
    if (args[0] === 'diff') return { code: 0, stdout: changed.join('\n') + '\n' };
    if (args[0] === 'ls-remote') return { code: 0, stdout: ++lsRemote >= tagAfter ? `abc\t${args[3]}\n` : '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { git, calls };
}

const rules = (r: unknown[]) => JSON.stringify(r);

test('no rules or an empty list passes without running git', async () => {
  const { git, calls } = fakeGit([]);
  deepEqual(await hook.evaluate({ E2E_EVENT: 'push' }, { git }), []);
  deepEqual(await hook.evaluate({ E2E_RULES: '[]', E2E_EVENT: 'push' }, { git }), []);
  deepEqual(calls, []);
});

test('a pull_request diffs the merge commit against its first parent; push diffs against before', async () => {
  const pr = fakeGit(['src/x.js']);
  await hook.evaluate(
    {
      E2E_RULES: rules([{ when: 'src/x.js', require: { file: 'CHANGELOG.md', contains: 'x' } }]),
      E2E_EVENT: 'pull_request',
    },
    { git: pr.git, readFile: () => 'x' },
  );
  deepEqual(pr.calls[0], ['diff', '--name-only', 'HEAD^1', 'HEAD']);
  const push = fakeGit(['src/x.js']);
  await hook.evaluate(
    {
      E2E_RULES: rules([{ when: 'src/x.js', require: { file: 'README.md', contains: 'x' } }]),
      E2E_EVENT: 'push',
      E2E_BEFORE: 'b'.repeat(40),
    },
    { git: push.git, readFile: () => 'x' },
  );
  deepEqual(push.calls[0], ['diff', '--name-only', 'b'.repeat(40), 'HEAD']);
});

test('require fails only when its when path changed and the file lacks the text', async () => {
  const env = {
    E2E_RULES: rules([
      { when: 'src/f.js', event: 'pull_request', require: { file: 'CHANGELOG.md', contains: 'f-r1' } },
    ]),
    E2E_EVENT: 'pull_request',
  };
  deepEqual(await hook.evaluate(env, { git: fakeGit(['src/f.js']).git, readFile: () => '' }), [
    'CHANGELOG.md must mention f-r1 because src/f.js changed',
  ]);
  deepEqual(
    await hook.evaluate(env, { git: fakeGit(['src/f.js', 'CHANGELOG.md']).git, readFile: () => '- f-r1\n' }),
    [],
  );
  deepEqual(await hook.evaluate(env, { git: fakeGit(['src/other.js']).git, readFile: () => '' }), []);
  const missing = await hook.evaluate(env, {
    git: fakeGit(['src/f.js']).git,
    readFile: () => {
      throw new Error('ENOENT');
    },
  });
  equal(missing.length, 1);
});

test('a merge that does not change the when path passes', async () => {
  const env = {
    E2E_RULES: rules([{ when: 'src/f.js', event: 'push', require: { file: 'README.md', contains: 'f-r1' } }]),
    E2E_EVENT: 'push',
    E2E_BEFORE: 'a'.repeat(40),
  };
  deepEqual(await hook.evaluate(env, { git: fakeGit(['README.md']).git, readFile: () => '' }), []);
});

test('event and attempt filters', async () => {
  const r = rules([{ when: 'src/a.js', event: 'push', attempt: 2, require: { file: 'X', contains: 'y' } }]);
  const git = fakeGit(['src/a.js']).git;
  const base = { E2E_RULES: r, E2E_BEFORE: 'a'.repeat(40) };
  deepEqual(
    await hook.evaluate({ ...base, E2E_EVENT: 'pull_request', GITHUB_RUN_ATTEMPT: '2' }, { git, readFile: () => '' }),
    [],
  );
  deepEqual(
    await hook.evaluate({ ...base, E2E_EVENT: 'push', GITHUB_RUN_ATTEMPT: '1' }, { git, readFile: () => '' }),
    [],
  );
  equal(
    (await hook.evaluate({ ...base, E2E_EVENT: 'push', GITHUB_RUN_ATTEMPT: '2' }, { git, readFile: () => '' })).length,
    1,
  );
});

test('a diff that cannot be computed fails and names the command', async () => {
  const r = rules([{ when: 'src/a.js', holdTag: 't' }]);
  const failing: Git = () => ({ code: 128, stdout: '', stderr: 'bad revision' });
  await rejects(
    hook.evaluate({ E2E_RULES: r, E2E_EVENT: 'push', E2E_BEFORE: 'a'.repeat(40) }, { git: failing }),
    /git diff --name-only a+ HEAD failed: bad revision/,
  );
  await rejects(
    hook.evaluate({ E2E_RULES: r, E2E_EVENT: 'push', E2E_BEFORE: '0'.repeat(40) }, { git: failing }),
    /cannot compute the changed paths/,
  );
  await rejects(
    hook.evaluate({ E2E_RULES: r, E2E_EVENT: 'workflow_dispatch' }, { git: failing }),
    /cannot compute the changed paths/,
  );
});

test('holdTag passes once the tag exists and fails at the 25-minute limit', async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms), log: () => {} };
  const env = {
    E2E_RULES: rules([{ when: 'src/a.js', holdTag: 'r1-a-cd' }]),
    E2E_EVENT: 'push',
    E2E_BEFORE: 'a'.repeat(40),
  };
  const held = fakeGit(['src/a.js'], 4);
  deepEqual(await hook.evaluate(env, { git: held.git, ...clock }), []);
  deepEqual(held.calls.at(-1), ['ls-remote', '--tags', 'origin', 'refs/tags/r1-a-cd']);
  equal(t, 30_000);
  t = 0;
  deepEqual(await hook.evaluate(env, { git: fakeGit(['src/a.js']).git, ...clock }), [
    'tag r1-a-cd did not appear within 25 minutes',
  ]);
  equal(t >= 25 * 60_000, true);
});

test('the template workflows run the hook and time out after the hold limit', () => {
  for (const name of ['ci.yml', 'cd.yml']) {
    const text = readFileSync(join(root, '.github', 'workflows', name), 'utf8');
    const minutes = Number(/timeout-minutes:\s*(\d+)/.exec(text)?.[1]);
    equal(minutes * 60_000 > hook.HOLD_LIMIT_MS, true, `${name} timeout ${minutes} min`);
    match(text, /run: node scripts\/e2e-hook\.js/);
    match(text, /fetch-depth: 0/);
    match(text, /persist-credentials: false/);
    match(text, /E2E_BEFORE: \$\{\{ github\.event\.before \}\}/);
  }
  match(
    readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
    /E2E_RULES: \$\{\{ vars\.E2E_CI_RULES \}\}/,
  );
  match(
    readFileSync(join(root, '.github', 'workflows', 'cd.yml'), 'utf8'),
    /E2E_RULES: \$\{\{ vars\.E2E_CD_RULES \}\}/,
  );
});
