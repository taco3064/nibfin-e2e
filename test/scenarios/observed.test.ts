import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentSetup } from '../../scenarios/agent-setup.ts';
import { codexJobs } from '../../scenarios/codex-jobs.ts';
import { jobContainer } from '../../scenarios/job-container.ts';
import { EXTEND_MARKER } from '../../scenarios/lib/files.ts';
import { missingApprovalLine, runObservedJob } from '../../scenarios/lib/observed.ts';
import type { ObservedFacts } from '../../scenarios/lib/observed.ts';
import { projectTools } from '../../scenarios/project-tools.ts';
import { roleSkills } from '../../scenarios/role-skills.ts';
import { createGitHub } from '../../src/host/github.ts';
import type { RunContext } from '../../src/types.ts';
import { fakeHostContext } from '../host/fakes.ts';
import { EXEC, setup } from './kit.ts';

const DIGEST = 'sha256:' + 'd'.repeat(64);
const IMAGE = `ghcr.io/taco3064/nibfin@${DIGEST}`;
const TOKEN = 'claude-token-value';

const PROBE = [
  '```e2e-probe',
  'uid=1000',
  'auto_memory=1',
  'ancestor=sh',
  'ancestor=claude',
  'ancestor=node',
  ...['CLAUDE.md', '.mcp.json', '.claude/skills/e2e-probe-skill/SKILL.md'].flatMap((f) => [`exists:${f}=yes`, `tracked:${f}=no`]),
  'workspace_settings=absent',
  'node=v22.15.0',
  'python=Python 3.13.7',
  'go=go version go1.24.2 linux/amd64',
  'first_instruction_line=# Shape',
  '```',
].join('\n');

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean) {
  for (let i = 0; i < 2000 && !cond(); i++) await tick();
  if (!cond()) throw new Error('the simulated step did not reach the expected point');
}

/** Simulates Nibfin around runObservedJob: three stage containers, a branch, a PR and a review comment. */
async function simulate() {
  let settings: Record<string, unknown> = { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, enableAllProjectMcpServers: true, theme: 'dark' };
  const h = setup({
    respond: (argv, o) => {
      const script = argv.at(-1) ?? '';
      if (script.startsWith('umask')) return ((settings = JSON.parse(o.input ?? '{}')), {});
      if (script.startsWith('stat')) return { stdout: `0 755\n0 600\n${JSON.stringify(settings)}` };
      if (argv[1] === 'container' && argv[2] === 'inspect') {
        return { stdout: JSON.stringify([{ ImageName: IMAGE, HostConfig: { Memory: 3e9, NanoCpus: 2e9, PidsLimit: 2048 }, Config: { Env: [`NIBFIN_RUN_ID=${argv[3]?.slice(1)}`, `NIBFIN_RUN_REPO=${EXEC}`] }, Mounts: [{ Source: '/vol/home', Destination: '/home/nibfin' }] }]) };
      }
      if (argv[1] === 'info') return { stdout: JSON.stringify({ host: { security: { rootless: true } } }) };
      if (argv[1] === 'images') return { stdout: JSON.stringify([{ Names: ['ghcr.io/taco3064/nibfin'], RepoDigests: [IMAGE] }]) };
      return undefined;
    },
  });
  const original = h.fake.fetch;
  h.kit.github = createGitHub(() => 'tok', async (input, init) => {
    const url = new URL(String(input));
    let m = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (m) return new Response(JSON.stringify({ total_count: 2, jobs: [{ id: Number(m[1]) * 10, name: 'route', runner_name: 'GitHub Actions 3', status: 'completed' }, { id: Number(m[1]), name: 'stage', runner_name: 'myhost-1a2b3c4d-claude-1', status: 'completed' }] }));
    m = /\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
    if (m) {
      return new Response(
        [`2026-11-26T00:00:00Z Nibfin image: ${IMAGE}`, '2026-11-26T00:00:01Z {"type":"system","subtype":"init","model":"claude-opus-4-5","mcp_servers":[{"name":"e2e-probe","status":"connected"}]}'].join('\n'),
      );
    }
    return original(input, init);
  });
  h.kit.workDir = mkdtempSync(join(tmpdir(), 'e2e-observed-'));
  const repo = h.repo(EXEC);
  const done = runObservedJob(h.kit);

  await until(() => repo.issues.length > 0 && h.events.open > 0);
  const issue = repo.issues[0] as (typeof repo.issues)[number];
  equal(settings.enableAllProjectMcpServers, undefined);
  h.events.emit('{"ID":"c1","Status":"start"}');
  await tick();
  issue.comments = [`## Shape\n\n${PROBE}\n`];
  settings = { ...settings, enableAllProjectMcpServers: true };
  issue.labels = ['scope', 'shaped'];
  h.events.emit('{"ID":"c1","Status":"died"}');

  await until(() => h.calls.some((c) => c.argv.join(' ').includes('e2e-decoy')));
  const branch = `nibfin/issue-${issue.number}`;
  h.fake.trees.set('branch-tree', new Map([['src/sum.js', { mode: '100644', content: 'x' }], ['test/sum.test.js', { mode: '100644', content: 'x' }]]));
  repo.commits.set('b1', { tree: 'branch-tree', parents: ['c0'] });
  repo.branches.set(branch, 'b1');
  repo.pulls.push({ number: 77, state: 'open', head: { sha: 'b1', ref: branch } });
  repo.issues.push({ number: 77, node_id: 'PR77', state: 'open', comments: ['Shape review: the change matches the approved Shape.', 'Waiting for an approving review from a collaborator before merging.'] });
  h.events.emit('{"ID":"c2","Status":"start"}');
  h.events.emit('{"ID":"c2","Status":"died"}');
  h.events.emit('{"ID":"c3","Status":"start"}');
  h.events.emit('{"ID":"c3","Status":"died"}');
  return { h, out: await done, issue };
}

function ctxWith(facts: ObservedFacts): RunContext {
  return { ...fakeHostContext, target: { ghNibfinCommit: 'a'.repeat(40), platform: 'linux' }, log: () => {}, facts: (id) => (id === 'observed-job' ? (facts as unknown as Record<string, unknown>) : id === 'nibfin' ? { imageDigest: DIGEST } : undefined) };
}

test('observed-job runs one fixture through Shape, Deliver and Review and records only derived facts', async () => {
  const { h, out, issue } = await simulate();
  equal(out.status, 'passed', out.reason);
  const f = out.facts as unknown as ObservedFacts;
  equal(f.issue, issue.number);
  equal(f.projection?.imageName, IMAGE);
  equal(f.rootless, true);
  deepEqual(f.probe?.node, ['v22.15.0']);
  deepEqual(f.shapeLog?.slot, 'claude-1');
  deepEqual(f.loginBefore?.enableAllProjectMcpServers, undefined);
  deepEqual(f.loginAfter?.enableAllProjectMcpServers, true);
  deepEqual(f.branchPaths, ['src/sum.js', 'test/sum.test.js']);
  deepEqual(f.finish, { merged: false, approvalComment: 'Waiting for an approving review from a collaborator before merging.' });
  equal(JSON.stringify(out).includes(TOKEN), false);
  // The fixture: tools, the extend Skill, probe, rulesync sources and decoys; the approval ruleset after the content.
  const w = h.fake.writes;
  ok(w.indexOf(`PATCH /repos/${EXEC}/git/refs/heads/main`) < w.indexOf(`POST /repos/${EXEC}/rulesets`));
  deepEqual([issue.state, issue.state_reason], ['closed', 'not_planned']);
  deepEqual(h.repo(EXEC).rulesets, []);
  equal(h.repo(EXEC).variableValues.get('NIBFIN_MODEL'), 'haiku');

  for (const s of [jobContainer, agentSetup, projectTools, roleSkills]) {
    const r = await s.run(ctxWith(f));
    equal(r.status, 'passed', `${s.id}: ${r.reason}`);
  }
});

test('the fact-reading scenarios fail listing each check that did not hold, per rule', async () => {
  const { out } = await simulate();
  const f = structuredClone(out.facts) as unknown as ObservedFacts;
  f.rootless = false;
  if (f.projection) f.projection.pidsLimit = 0;
  f.branchPaths = ['CLAUDE.md', '.claude/settings.json', 'src/sum.js'];
  if (f.probe) {
    f.probe.ancestor = ['sh', 'bwrap', 'claude'];
    f.probe.node = ['v20.0.0'];
    f.probe.first_instruction_line = [EXTEND_MARKER];
  }
  f.decoys = { tools: ['e2e-decoy-dockerfile'], login: [] };
  const job = await jobContainer.run(ctxWith(f));
  equal(job.status, 'failed');
  match(job.reason, /R6\.2: Podman runs rootless \(observed: rootless=false\)/);
  match(job.reason, /R6\.2: memory, CPU and process limits are set/);
  const agent = await agentSetup.run(ctxWith(f));
  match(agent.reason, /R6\.18: the pushed branch contains no generated agent file \(observed: CLAUDE\.md, \.claude\/settings\.json\)/);
  match(agent.reason, /R6\.10: the agent shell does not run under the CLI sandbox/);
  const tools = await projectTools.run(ctxWith(f));
  match(tools.reason, /R7\.3: node is the requested v22\.15\.0.*observed: v20\.0\.0.*no Repository Dockerfile or script ran \(observed: nibfin-tools:e2e-decoy-dockerfile\)/);
  match((await roleSkills.run(ctxWith(f))).reason, /R7\.6: extend keeps the built-in text first/);
});

test('only a Nibfin comment saying an approving review is missing counts', () => {
  const by = (login: string, body: string) => ({ body, user: { login } });
  equal(missingApprovalLine([by('o', 'Review: looks good, merging next.'), by('someone', 'Waiting for approval')], 'o'), undefined);
  equal(missingApprovalLine([by('o', 'Shape review passed.\nMerge is blocked: waiting for 1 approving review.')], 'o'), 'Merge is blocked: waiting for 1 approving review.');
});

test('codex-jobs waits for Phase 5', async () => {
  const r = await codexJobs.run(ctxWith({ repo: EXEC }));
  deepEqual([r.status, /Phase 5/.test(r.reason)], ['waiting', true]);
});
