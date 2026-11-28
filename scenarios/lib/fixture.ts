import { commitOnMain, createTree, mainHead, rulesets } from '../../src/host/sandbox.ts';
import type { TreeEntry } from '../../src/host/sandbox.ts';
import { excerpt, redact } from './checks.ts';
import { runningJobContainers, watchJobContainers } from './containers.ts';
import { runnerCount } from './github.ts';
import { baselineOf } from './kit.ts';
import type { Kit } from './kit.ts';
import { idleProblem, localRunners } from './runners.ts';
import type { LocalRunner } from './runners.ts';
import { DEADLINE, remoteWait } from './waits.ts';

/** Repository variables the library manages; variables `init` owns are never touched. */
export const LIBRARY_VARIABLES = ['NIBFIN_MODEL', 'NIBFIN_CONTAINER_LIMITS', 'NIBFIN_MEMORY'] as const;
export type LibraryVariable = (typeof LIBRARY_VARIABLES)[number];

/** A fixture file: text content, or a symlink to `symlink`. */
export type FixtureFile = { path: string; content: string } | { path: string; symlink: string };

export interface FixtureRuleset {
  /** Must start with `e2e-`. */
  name: string;
  body: Record<string, unknown>;
}

export interface FixtureState {
  files: FixtureFile[];
  variables?: Partial<Record<LibraryVariable, string>>;
  ruleset?: FixtureRuleset;
}

/** A ruleset on the default branch requiring one approving review, with no bypass actor. */
export function approvalRuleset(name = 'e2e-approval'): FixtureRuleset {
  return {
    name,
    body: {
      name,
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
      ],
    },
  };
}

interface Issue {
  number: number;
  pull_request?: unknown;
}

/** Closes every open Issue as not planned, so Nibfin starts no further stage for it. */
async function closeOpenIssues(kit: Kit, repo: string): Promise<number[]> {
  const open = (await kit.github.list<Issue>(`/repos/${repo}/issues?state=open`)).filter(
    (i) => i.pull_request === undefined,
  );
  for (const i of open) await close(kit, repo, i.number);
  return open.map((i) => i.number);
}

/** Waits, on a `podman events` stream opened before the list, for every running Job container of the repository to end. */
async function waitForContainers(kit: Kit, repo: string): Promise<void> {
  const watch = watchJobContainers(kit, repo);
  try {
    const running = await runningJobContainers(kit.exec, repo);
    if (running.length) {
      kit.log(`${repo}: waiting for ${running.length} Job container(s) to end`);
      await watch.diedAll(running, DEADLINE.quiesce, `the earlier Job containers of ${repo} to end`);
    }
  } finally {
    watch.stop();
  }
}

/**
 * Re-reads the execution sandbox's Runners every 10 s until all of them (the count the
 * `nibfin` step added) are online and idle,
 * within the quiesce deadline: a Runner stays busy through a Job's post steps after its
 * container ended, and while a Job starts. A wrong set of registrations or a failed read
 * fails at once; the timeout names every Runner still busy or offline and the time waited.
 */
async function waitForIdleRunners(kit: Kit): Promise<void> {
  const execution = kit.sandbox.execution;
  const count = runnerCount(kit.facts);
  const start = kit.now();
  let last: LocalRunner[] | undefined;
  let readError: unknown;
  let logged = false;
  try {
    await remoteWait(kit, `all ${count} Runners of ${execution} to be online and idle`, DEADLINE.quiesce, 10_000, async () => {
      try {
        last = await localRunners(kit.github, execution, count);
      } catch (error) {
        readError = error;
        throw error;
      }
      const problem = idleProblem(last);
      if (problem === undefined) return last;
      if (!logged) {
        logged = true;
        kit.log(`${execution}: waiting for the Runners: ${problem}`);
      }
      return undefined;
    });
  } catch (error) {
    if (kit.signal.aborted || error === readError || last === undefined) throw error;
    throw new Error(
      `${idleProblem(last) ?? 'Runners not online and idle'} (after waiting ${Math.round((kit.now() - start) / 1000)} s)`,
      { cause: error },
    );
  }
}

interface Variable {
  name: string;
  value: string;
}

async function setVariables(kit: Kit, repo: string, wanted: Partial<Record<LibraryVariable, string>>): Promise<void> {
  const r = `/repos/${repo}/actions/variables`;
  const read = async () => new Map((await kit.github.list<Variable>(r, 'variables')).map((v) => [v.name, v.value]));
  const have = await read();
  for (const name of LIBRARY_VARIABLES) {
    const value = wanted[name];
    if (value === undefined) {
      if (have.has(name)) await kit.github.rest('DELETE', `${r}/${name}`);
    } else if (!have.has(name)) await kit.github.rest('POST', r, { name, value });
    else if (have.get(name) !== value) await kit.github.rest('PATCH', `${r}/${name}`, { name, value });
  }
  const after = await read();
  const wrong = LIBRARY_VARIABLES.filter((n) => after.get(n) !== wanted[n]);
  if (wrong.length)
    throw new Error(
      `${repo}: variables read back wrong: ${wrong.map((n) => `${n} is ${JSON.stringify(after.get(n) ?? null)}, expected ${JSON.stringify(wanted[n] ?? null)}`).join('; ')}`,
    );
}

async function clearE2eRulesets(kit: Kit, repo: string): Promise<void> {
  for (const rs of await rulesets(kit.github, repo))
    if (rs.name.startsWith('e2e-')) await kit.github.rest('DELETE', `/repos/${repo}/rulesets/${rs.id}`);
  const left = (await rulesets(kit.github, repo)).filter((rs) => rs.name.startsWith('e2e-'));
  if (left.length)
    throw new Error(`${repo}: rulesets ${left.map((r) => r.name).join(', ')} are still present after deleting them`);
}

function entries(files: FixtureFile[]): TreeEntry[] {
  return files.map((f) =>
    'symlink' in f
      ? { path: f.path, mode: '120000', content: f.symlink }
      : { path: f.path, mode: '100644', content: f.content },
  );
}

/** Makes main's tree the baseline plus exactly `files`; returns the tree sha. */
async function writeContent(kit: Kit, repo: string, files: FixtureFile[]): Promise<string> {
  const base = baselineOf(kit, repo);
  const head = await mainHead(kit.github, repo);
  if (!head) throw new Error(`${repo}: branch main does not exist`);
  const tree = files.length ? await createTree(kit.github, repo, entries(files), base.tree) : base.tree;
  if (head.tree !== tree)
    await commitOnMain(
      kit.github,
      repo,
      tree,
      head.commit,
      `nibfin-e2e fixture: ${files.map((f) => f.path).join(', ') || 'baseline'}`,
    );
  const after = await mainHead(kit.github, repo);
  if (after?.tree !== tree)
    throw new Error(`${repo}: main's tree reads back ${String(after?.tree)}, expected the fixture tree ${tree}`);
  return tree;
}

/**
 * Puts the sandbox into a state that depends only on the arguments, in four phases that
 * each must succeed before the next: quiesce (no open Issue, no running Job container,
 * then a wait of up to DEADLINE.quiesce for both Runners to be online and idle), clear settings (library variables and `e2e-` rulesets),
 * content (main = baseline + `files`), then the fixture ruleset. Every fixture runs it first.
 */
export async function prepareFixture(kit: Kit, repo: string, state: FixtureState): Promise<{ tree: string }> {
  if (state.ruleset) {
    if (repo === kit.sandbox.peer)
      throw new Error(
        `${repo}: the private peer sandbox has no rulesets on its plan (Proposal R3.55); a fixture cannot add one`,
      );
    if (!state.ruleset.name.startsWith('e2e-'))
      throw new Error(`fixture ruleset ${state.ruleset.name}: the name must start with e2e-`);
  }
  // 1. Quiesce. The Runners register only on the execution sandbox, whatever `repo` is.
  await closeOpenIssues(kit, repo);
  await waitForContainers(kit, repo);
  await waitForIdleRunners(kit);
  // 2. Clear settings: nothing may refuse or change the content write.
  await setVariables(kit, repo, state.variables ?? {});
  await clearE2eRulesets(kit, repo);
  // 3. Content.
  const tree = await writeContent(kit, repo, state.files);
  // 4. Fixture ruleset, only after the content read-back.
  if (state.ruleset) {
    await kit.github.rest('POST', `/repos/${repo}/rulesets`, state.ruleset.body);
    const got = (await rulesets(kit.github, repo)).filter((rs) => rs.name === state.ruleset?.name);
    if (got.length !== 1)
      throw new Error(`${repo}: ruleset ${state.ruleset.name} reads back ${got.length} time(s), expected once`);
  }
  return { tree };
}

/** Deletes the `e2e-` rulesets of a repository (tidiness; the next prepareFixture does it too). */
export async function deleteE2eRulesets(kit: Kit, repo: string): Promise<void> {
  await clearE2eRulesets(kit, repo);
}

/** Opens a fixture Issue with `scope`, assigned to the sandbox owner, and returns its number. */
export async function openFixture(kit: Kit, repo: string, title: string, body: string): Promise<number> {
  const owner = repo.split('/')[0] as string;
  const { data } = await kit.github.rest<{ number: number }>('POST', `/repos/${repo}/issues`, {
    title,
    body,
    labels: ['scope'],
    assignees: [owner],
  });
  kit.log(`${repo}: opened fixture #${data.number} (${title})`);
  return data.number;
}

export interface Comment {
  body: string;
  user?: { login: string };
}

export const comments = (kit: Kit, repo: string, n: number) =>
  kit.github.list<Comment>(`/repos/${repo}/issues/${n}/comments`);

export async function labels(kit: Kit, repo: string, n: number): Promise<string[]> {
  return (await kit.github.list<{ name: string }>(`/repos/${repo}/issues/${n}/labels`)).map((l) => l.name);
}

export async function close(kit: Kit, repo: string, n: number): Promise<void> {
  await kit.github.rest('PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed', state_reason: 'not_planned' });
}

export async function addLabel(kit: Kit, repo: string, n: number, label: string): Promise<void> {
  await kit.github.rest('POST', `/repos/${repo}/issues/${n}/labels`, { labels: [label] });
}

/** The Issue's labels and latest comment, for a failure message, with secret values removed (GitHub does not mask comments). */
export async function issueState(kit: Kit, repo: string, n: number): Promise<string> {
  try {
    const l = await labels(kit, repo, n);
    const body = (await comments(kit, repo, n)).at(-1)?.body.trim();
    const last = body === undefined ? 'none' : excerpt(body, 1500, kit.secrets());
    return `${repo}#${n} labels [${l.join(', ')}]; latest comment: ${last}`;
  } catch (error) {
    return redact(
      `${repo}#${n}: reading its state failed: ${error instanceof Error ? error.message : String(error)}`,
      kit.secrets(),
    );
  }
}
