import type { GitHub } from '../../src/host/github.ts';
import type { Scenario } from '../../src/types.ts';
import { Check, message } from '../lib/check.ts';
import { nibfinFacts, readFile } from '../lib/github.ts';
import { tagDigest } from '../lib/image.ts';
import { readWorkflow, titleStartsWith, triggers, unpinnedImages } from '../lib/workflows.ts';

const WF = '.github/workflows/';

/** The files each init PR may add, as Proposal R5.2–R5.3 name them. */
export const EXPECTED = {
  execution: [`${WF}nibfin-issue.yml`, `${WF}nibfin-shared-runner.yml`, `${WF}nibfin-job.yml`, `${WF}nibfin-runner-request.yml`],
  peer: [`${WF}nibfin-issue.yml`],
};

/**
 * How Proposal R5.7 judges one `uses:` value that names the Owner: undefined when it does
 * not name `taco3064/`, the commit SHA of an allowed nibfin-core JavaScript Action, or why
 * it is not allowed. Only `taco3064/nibfin-core[/<path>]@<40-hex SHA>` that is not a reusable
 * workflow is allowed.
 */
export function ownerUse(u: string): { sha: string } | { why: string } | undefined {
  if (!/taco3064\//i.test(u)) return undefined;
  const m = /^taco3064\/([^/@\s]+)((?:\/[^@\s]+)?)@([^@\s]+)$/i.exec(u);
  if (!m) return { why: 'a workflow or action of the Owner' };
  const [, repo = '', path = '', ref = ''] = m;
  if (repo.toLowerCase() !== 'nibfin-core') return { why: 'a workflow or action of another Owner repository; R5.7 allows only the taco3064/nibfin-core Action' };
  if (/^\/\.github\/workflows\//i.test(path)) return { why: 'a reusable workflow of nibfin-core, which R5.7 does not allow' };
  if (!/^[0-9a-f]{40}$/.test(ref)) return { why: `pinned to ${ref}, not a full 40-character commit SHA` };
  return { sha: ref };
}

/** What `ghcr.io/taco3064/nibfin:<sha>` points at, per nibfin-core commit SHA: its digest (none on a 404) or the read error. */
export type ImageTags = ReadonlyMap<string, { digest?: string } | { error: string }>;

/** Every check on one init PR's files; all of them run even after an unexpected file. */
export function checkInitFiles(c: Check, repo: string, kind: 'execution' | 'peer', files: { path: string; text: string }[], digest: string, tags: ImageTags = new Map()): void {
  const paths = files.map((f) => f.path).sort();
  const expected = EXPECTED[kind];
  const extra = paths.filter((p) => !expected.includes(p));
  const missing = expected.filter((p) => !paths.includes(p));
  const rule = kind === 'execution' ? 'R5.3' : 'R5.2';
  c.that(!missing.length, rule, `${repo} init PR lacks ${missing.join(', ')}`);
  for (const p of extra) {
    const r = /producer-pins\.json$/.test(p) ? 'R5.4' : /wake/i.test(p) ? 'R5.4' : rule;
    c.fail(r, `${repo} init PR adds ${p}, which is not in the ${kind} set (${expected.map((e) => e.slice(WF.length)).join(', ')}) and nothing else`);
  }
  c.that(
    (kind === 'execution') === paths.includes(`${WF}nibfin-shared-runner.yml`),
    'R5.37',
    `${repo} init PR ${kind === 'execution' ? 'lacks' : 'has'} nibfin-shared-runner.yml, so it is not the ${kind} version`,
  );

  for (const f of files) {
    const w = readWorkflow(f.text);
    const isWorkflow = f.path.startsWith(WF);
    c.that(isWorkflow && /^nibfin-[^/]+\.yml$/.test(f.path.slice(WF.length)), 'R5.5', `${repo}: ${f.path} is not named .github/workflows/nibfin-*.yml`);
    if (isWorkflow) {
      c.that(!!w.name?.startsWith('Nibfin · '), 'R5.5', `${repo}: ${f.path} name is ${JSON.stringify(w.name ?? null)}, expected "Nibfin · …"`);
      // A workflow only other workflows call creates no run of its own, so GitHub renders no title from it.
      const reusableOnly = triggers(f.text).join() === 'workflow_call';
      if (!reusableOnly) {
        c.that(titleStartsWith(w.runName ?? '', 'Nibfin'), 'R5.5', `${repo}: ${f.path} run-name is ${JSON.stringify(w.runName ?? null)}, expected to start with "Nibfin"`);
      }
    }
    for (const u of w.uses) {
      const owner = ownerUse(u);
      if (!owner) continue;
      if ('why' in owner) {
        c.fail('R5.7', `${repo}: ${f.path} uses ${u}, ${owner.why}`);
        continue;
      }
      const tag = `ghcr.io/taco3064/nibfin:${owner.sha}`;
      const found = tags.get(owner.sha);
      if (found && 'error' in found) c.fail('R5.7', `${repo}: ${f.path} uses ${u}, but ${tag} could not be read: ${found.error}`);
      else if (!found?.digest) c.fail('R5.7', `${repo}: ${f.path} uses ${u}, whose image tag ${tag} has no digest (none), expected ${digest}`);
      else if (found.digest !== digest) c.fail('R5.7', `${repo}: ${f.path} uses ${u}, whose image tag ${tag} is ${found.digest}, expected ${digest}`);
    }
    c.that(!/github\.com\/taco3064\//i.test(f.text), 'R5.7', `${repo}: ${f.path} refers to a github.com/taco3064/ repository`);
    const callers = files.filter((o) => o !== f && localCalls(o.text).includes(f.path)).map((o) => o.text);
    for (const { ref, why } of unpinnedImages(f.text, digest, callers)) {
      c.fail('R5.7', `${repo}: ${f.path} references ${ref}${why ? ` ${why}` : ''}, expected ghcr.io/taco3064/nibfin@${digest}`);
    }
    if (w.images.length) c.that(/\bpodman\b/.test(f.text), 'R5.7', `${repo}: ${f.path} references the image but does not run it with podman`);
  }

  const shared = files.find((f) => f.path === `${WF}nibfin-shared-runner.yml`);
  if (shared) {
    // The shared runner's own Jobs and the local reusable workflows it calls, transitively.
    const reached = [shared];
    for (let i = 0; i < reached.length; i++) {
      for (const p of localCalls((reached[i] as { text: string }).text)) {
        const called = files.find((f) => f.path === p);
        if (called && !reached.includes(called)) reached.push(called);
      }
    }
    const runsOn = reached.flatMap((f) => readWorkflow(f.text).runsOn);
    const calledNames = reached.slice(1).map((f) => f.path.slice(WF.length));
    const where = calledNames.length ? `nibfin-shared-runner.yml or the local workflows it calls (${calledNames.join(', ')})` : 'nibfin-shared-runner.yml';
    c.that(runsOn.some((v) => /nibfin-/.test(v)), 'R5.7', `${repo}: no runs-on in ${where} uses a nibfin- label (${runsOn.join(' | ') || 'none'})`);
  }
}

/** The repository paths of the local reusable workflows a workflow calls (`uses: ./.github/workflows/…`). */
function localCalls(text: string): string[] {
  return readWorkflow(text)
    .uses.filter((u) => u.startsWith(`./${WF}`))
    .map((u) => u.slice(2).replace(/@.*$/, ''));
}

/** The GHCR commit tag of every allowed nibfin-core Action the files call; no Action means no read. */
async function actionTags(files: { text: string }[]): Promise<ImageTags> {
  const shas = new Set<string>();
  for (const f of files) {
    for (const u of readWorkflow(f.text).uses) {
      const owner = ownerUse(u);
      if (owner && 'sha' in owner) shas.add(owner.sha);
    }
  }
  const tags = new Map<string, { digest?: string } | { error: string }>();
  for (const sha of shas) {
    try {
      tags.set(sha, { digest: await tagDigest(sha) });
    } catch (e) {
      tags.set(sha, { error: message(e) });
    }
  }
  return tags;
}

/** The files a PR adds or changes, read at its head. */
async function prFiles(gh: GitHub, repo: string, n: number): Promise<{ path: string; text: string }[]> {
  const { data: pr } = await gh.rest<{ head: { sha: string } }>('GET', `/repos/${repo}/pulls/${n}`);
  const list = await gh.list<{ filename: string; status: string }>(`/repos/${repo}/pulls/${n}/files`);
  const out: { path: string; text: string }[] = [];
  for (const f of list) {
    if (f.status === 'removed') continue;
    const file = await readFile(gh, repo, f.filename, pr.head.sha);
    out.push({ path: f.filename, text: file?.text ?? '' });
  }
  return out;
}

export const initFiles: Scenario = {
  id: 'init-files',
  rules: ['R5.2', 'R5.3', 'R5.4', 'R5.5', 'R5.7', 'R5.37'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const facts = nibfinFacts(ctx);
    const { execution, peer } = ctx.sandbox;
    const execFiles = await prFiles(ctx.github, execution, facts.executionPr);
    const peerFiles = await prFiles(ctx.github, peer, facts.peerPr);
    const tags = await actionTags([...execFiles, ...peerFiles]);
    checkInitFiles(c, execution, 'execution', execFiles, facts.imageDigest, tags);
    checkInitFiles(c, peer, 'peer', peerFiles, facts.imageDigest, tags);
    return c.outcome(`init wrote exactly the execution and peer sets, Nibfin-named, self-contained and pinned to ${facts.imageDigest}`);
  },
};
