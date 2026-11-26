import type { GitHub } from '../../src/host/github.ts';
import type { Scenario } from '../../src/types.ts';
import { Check } from '../lib/check.ts';
import { nibfinFacts, readFile } from '../lib/github.ts';
import { readWorkflow } from '../lib/workflows.ts';

const WF = '.github/workflows/';

/** The files each init PR may add, as Issue #284 and Proposal R5.2–R5.3 name them. */
export const EXPECTED = {
  execution: [`${WF}nibfin-issue.yml`, `${WF}nibfin-shared-runner.yml`],
  peer: [`${WF}nibfin-issue.yml`],
};

/** Every check on one init PR's files; all of them run even after an unexpected file. */
export function checkInitFiles(c: Check, repo: string, kind: 'execution' | 'peer', files: { path: string; text: string }[], digest: string): void {
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
      c.that(!!w.runName?.startsWith('Nibfin'), 'R5.5', `${repo}: ${f.path} run-name is ${JSON.stringify(w.runName ?? null)}, expected to start with "Nibfin"`);
    }
    for (const u of w.uses) c.that(!/taco3064\//i.test(u), 'R5.7', `${repo}: ${f.path} uses ${u}, a workflow or action of the Owner`);
    c.that(!/github\.com\/taco3064\//i.test(f.text), 'R5.7', `${repo}: ${f.path} refers to a github.com/taco3064/ repository`);
    for (const img of w.images) {
      c.that(img === `ghcr.io/taco3064/nibfin@${digest}`, 'R5.7', `${repo}: ${f.path} references ${img}, expected ghcr.io/taco3064/nibfin@${digest}`);
    }
    if (w.images.length) c.that(/\bpodman\b/.test(f.text), 'R5.7', `${repo}: ${f.path} references the image but does not run it with podman`);
  }

  const shared = files.find((f) => f.path === `${WF}nibfin-shared-runner.yml`);
  if (shared) {
    const runsOn = readWorkflow(shared.text).runsOn;
    c.that(runsOn.some((v) => /nibfin-/.test(v)), 'R5.7', `${repo}: no runs-on in nibfin-shared-runner.yml uses a nibfin- label (${runsOn.join(' | ') || 'none'})`);
  }
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
    checkInitFiles(c, execution, 'execution', await prFiles(ctx.github, execution, facts.executionPr), facts.imageDigest);
    checkInitFiles(c, peer, 'peer', await prFiles(ctx.github, peer, facts.peerPr), facts.imageDigest);
    return c.outcome(`init wrote exactly the execution and peer sets, Nibfin-named, self-contained and pinned to ${facts.imageDigest}`);
  },
};
