// Phase 2 scenarios with their own fixtures: routing, the peer, protected paths and fix loops.
import type { Scenario } from '../../src/types.ts';
import { AGENT_STAGES, Checks, fixPushProblems, isIssueBranch, markerOf, reasonOf, time } from './analysis.ts';
import type { Issue, Job, Pull, Run, Stage } from './analysis.ts';
import { DEADLINE, changeRequest, lifecycle } from './kit.ts';
import type { Kit } from './kit.ts';
import type { Snapshot } from './observe.ts';
import { closingProblems } from './phase1.ts';

export const assigneeRouting: Scenario = lifecycle({
  id: 'assignee-routing',
  concurrent: true,
  rules: ['R4.18', 'R4.20', 'R4.22', 'R4.24', 'R4.26'],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    const filed: number[] = [];
    try {
      await k.baseline();
      const owner = await k.owner();
      const label = await k.ownerLabel();
      const collaborators = await k.gh.list<{ login: string }>(`/repos/${exec}/collaborators`);
      const other = collaborators.find((x) => x.login.toLowerCase() !== owner.login.toLowerCase());
      if (!other) return { status: 'failed', reason: `R4.20: ${exec} has no collaborator besides ${owner.login}; the second account (#300) must be a collaborator` };

      // M1: only a member without Runners: a plain assignment, no action and no comment (R4.22).
      const m1 = await k.file(exec, { scenario: 'assignee-routing', title: 'Add triple', body: changeRequest(k.slug('m1'), 'triple', 'returns its argument times three'), labels: ['scope'], assignees: [other.login] });
      filed.push(m1.number);
      const m1At = k.now();
      await k.obs.until('M1\'s wake and route runs to complete', (s) => (k.stages(s, exec, m1.number, ['route']).some((r) => r.status === 'completed') ? true : undefined), DEADLINE.event, k.show(exec, m1.number));
      const s1 = await k.settle('M1 routed', m1At);
      c.check('R4.22', k.stages(s1, exec, m1.number, AGENT_STAGES).length === 0, 'M1, assigned only to a member without Runners, got an agent stage');
      c.check('R4.22', (await k.obs.comments(exec, m1.number)).length === 0, 'Nibfin commented on M1');
      c.check('R4.22', !k.labels(s1, exec, m1.number).includes('pause'), 'M1 got pause');

      // M2: reassigned during Shape to [collaborator, Owner].
      const m2 = await k.file(exec, { scenario: 'assignee-routing', title: 'Add square', body: changeRequest(k.slug('m2'), 'square', 'returns its argument squared'), labels: ['scope'], assignees: [owner.login] });
      filed.push(m2.number);
      const n = m2.number;
      const show = k.show(exec, n);
      const shapeJob = await k.obs.until('M2\'s shape job to run', async (s) => (await k.agentJobs(s, exec, n, ['shape'])).find((j) => j.status === 'in_progress'), DEADLINE.stage, show);
      await k.gh.rest('PATCH', `/repos/${exec}/issues/${n}`, { assignees: [other.login, owner.login] });
      const { data: back } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${n}`);
      const order = back.assignees.map((a) => a.login);
      k.ctx.log(`assignee-routing: GitHub returns the Assignees of #${n} as ${order.join(', ')}`);
      await k.obs.until('M2 to get pause and a comment naming the collaborator', async (s) => {
        if (!k.labels(s, exec, n).includes('pause')) return undefined;
        return (await k.obs.comments(exec, n)).find((x) => markerOf(x.body) && x.body?.includes(other.login)) ? s : undefined;
      }, DEADLINE.stage, show);
      const shape = await k.obs.until('the running shape job to complete', async () => {
        const j = await k.obs.job(exec, shapeJob.id);
        return j.status === 'completed' ? j : undefined;
      }, DEADLINE.stage, show);
      c.check('R4.24', shape.conclusion === 'success', `the shape job running at the reassignment concluded ${String(shape.conclusion)}`);
      await k.obs.until('`shaped`', (s) => (k.labels(s, exec, n).includes('shaped') ? true : undefined), DEADLINE.event, show);
      await k.removeLabel(exec, n, 'pause');
      const removedAt = k.now();
      const deliver = await k.obs.until('M2\'s deliver job to start', async (s) => (await k.agentJobs(s, exec, n, ['deliver'])).find((j) => j.status !== 'queued' && time(j.created_at ?? j.started_at) >= removedAt - 60_000), DEADLINE.stage, show);
      const firstWithRunners = order.find((l) => l.toLowerCase() === owner.login.toLowerCase());
      c.check('R4.20', !!firstWithRunners && deliver.labels.includes(label), `M2's deliver ran with ${deliver.labels.join(', ')}; the first Assignee with Runners in GitHub's order (${order.join(', ')}) is ${owner.login} (${label})`);
      c.check('R4.18', deliver.labels.includes(label), `routing used ${deliver.labels.join(', ')}, not the Assignee's label ${label}`);
      const pauses = (await k.obs.timeline(exec, n)).filter((e) => e.event === 'labeled' && e.label?.name === 'pause');
      c.check('R4.26', pauses.length === 1, `pause was added ${pauses.length} times; expected once for ${other.login}`);
      await k.addLabels(exec, n, ['pause']);
      return c.outcome(`M1 (only ${other.login}) was left alone; M2 got one pause for ${other.login} and was delivered on ${label}`);
    } finally {
      await k.pauseOpen(exec, filed);
    }
  },
});

/**
 * Commits a different wording of sum's JSDoc line to main (a true conflict with the
 * Issue's change), unless the Issue's PR already merged; then returns undefined.
 */
export async function writeConflict(k: Kit, repo: string, branch: string, observedMerged: boolean): Promise<{ sha: string; at: number } | undefined> {
  if (observedMerged) return undefined;
  const prs = await k.gh.list<Pull>(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`);
  if (prs.some((p) => p.merged_at)) return undefined;
  const text = (await k.fileOn(repo, 'main', 'src/sum.js')) ?? '';
  const changed = text.replace(/\/\*\*[^\n]*\*\//, '/** Adds a and b together. */');
  const content = changed === text ? `/** Adds a and b together. */\n${text}` : changed;
  const sha = await k.commitFiles(repo, 'main', { 'src/sum.js': content }, 'Reword the sum JSDoc on main (e2e conflict)');
  return { sha, at: k.now() };
}

export const peerDispatch: Scenario = lifecycle({
  id: 'peer-dispatch',
  concurrent: true,
  rules: ['R3.18', 'R3.23', 'R3.33', 'R4.31', 'R4.32', 'R4.33', 'R4.34'],
  async run(k) {
    const c = new Checks();
    const { exec, peer } = k;
    let q: Issue | undefined;
    try {
      const owner = await k.owner();
      const label = await k.ownerLabel();
      const wording = 'Returns the sum of a and b.';
      q = await k.file(peer, {
        scenario: 'peer-dispatch',
        title: 'Reword the sum JSDoc',
        body: `In \`src/sum.js\`, change the JSDoc line \`/** Adds two numbers. */\` to \`/** ${wording} */\`. Change nothing else.\n\n_This Issue is an automated nibfin-e2e fixture._`,
        labels: ['scope'],
        assignees: [owner.login],
      });
      const n = q.number;
      const branch = `nibfin/issue-${n}`;
      const show = k.show(peer, n);

      // R3.18: a true conflict lands on main after the first push of Q's Deliver.
      const trigger = await k.obs.until('the first push to Q\'s branch while its deliver job runs', async (s) => {
        if (s.pulls.get(peer)?.some((p) => p.head.ref === branch && p.merged_at)) return 'merged' as const;
        const running = (await k.agentJobs(s, peer, n, ['deliver'])).some((j) => j.status === 'in_progress');
        if (!running) return undefined;
        const pushes = (await k.obs.activity(peer, { ref: `refs/heads/${branch}` })).filter((a) => a.activity_type === 'push' || a.activity_type === 'branch_creation');
        return pushes.length ? ('pushed' as const) : undefined;
      }, DEADLINE.delivery, show);
      const conflict = await writeConflict(k, peer, branch, trigger === 'merged');
      if (!conflict) c.notExercised('R3.18', 'the PR merged before the first observed push');

      await k.obs.until('Q to close with delivered', (s) => k.delivered(s, peer, n), DEADLINE.delivery, show);
      const s = await k.obs.fresh();
      const merged = (await k.obs.pullsByHead(peer, branch)).find((p) => p.merged_at);
      if (!merged) c.fail('R3.18', `no merged PR for ${branch}`);
      if (conflict && merged) {
        const forced = (await k.obs.activity(peer, { ref: `refs/heads/${branch}`, type: 'force_push' })).filter((a) => time(a.timestamp) >= conflict.at);
        c.check('R3.18', forced.length > 0, `${branch} was not rebased (no force push) after main changed`);
        c.check('R3.18', await k.obs.descends(peer, conflict.sha, merged.head.sha), `the merged head ${merged.head.sha} does not descend from the conflicting main commit ${conflict.sha}`);
        c.check('R3.18', ((await k.fileOn(peer, 'main', 'src/sum.js')) ?? '').includes(wording), `main's src/sum.js does not carry the Issue's wording "${wording}"`);
      }

      // R4.31, R4.32: every stage ran in the execution repository; the peer only forwards events.
      const stageRuns = k.stages(s, peer, n);
      c.check('R4.31', stageRuns.length > 0 && stageRuns.every((r) => r.repo === exec), `Q's stage runs are not all in ${exec}`);
      const peerRuns = s.runs.filter((r) => r.repo === peer);
      const foreign = peerRuns.filter((r) => !['Nibfin · Issue events', 'CI', 'CD'].includes(r.name));
      c.check('R4.32', foreign.length === 0, `${peer} ran other workflows: ${[...new Set(foreign.map((r) => r.name))].join(', ')}`);
      const jobs = await k.agentJobs(s, peer, n);
      c.check('R4.31', jobs.length > 0 && jobs.every((j) => j.labels.includes(label)), `Q's agent jobs ran with ${[...new Set(jobs.map((j) => j.labels.join('+')))].join(', ')}`);

      // R3.23, R3.33: the peer has no ruleset, so no required checks: review runs without CI.
      const rules = await k.gh.rest<unknown[]>('GET', `/repos/${peer}/rulesets`, undefined, [403]);
      c.check('R3.33', rules.status === 403 || rules.data.length === 0, `${peer} has rulesets`);
      c.check('R3.23', k.stages(s, peer, n, ['review']).length > 0 && !!merged, 'Q was not reviewed and merged without CI');

      // R4.33, R4.34: init set the secret in both repositories; Nibfin writes as that login.
      for (const repo of [exec, peer]) {
        const got = await k.gh.rest('GET', `/repos/${repo}/actions/secrets/NIBFIN_GITHUB_TOKEN`, undefined, [404]);
        c.check('R4.33', got.status === 200, `${repo} has no NIBFIN_GITHUB_TOKEN Actions secret`);
      }
      if (merged) c.check('R4.34', merged.user?.login === owner.login, `PR #${merged.number} is by ${String(merged.user?.login)}`);
      for (const cm of (await k.obs.comments(peer, n)).filter((x) => markerOf(x.body))) c.check('R4.34', cm.user?.login === owner.login, `${cm.html_url} is by ${String(cm.user?.login)}`);
      return c.outcome(`${peer}#${n} was delivered by the execution repository's Runners and rebased over a conflicting main commit`);
    } finally {
      await k.pauseOpen(peer, [q?.number]);
    }
  },
});

/** Paths an agent must never change (Proposal R3.46); `docs/agent/deliver.md` is the role Skill file the baseline `.nibfin.json` names. */
export const isProtected = (file: string) =>
  file === '.nibfin.json' || file.startsWith('.nibfin/') || file.startsWith('.rulesync/') || file.startsWith('.github/workflows/') || /(^|\/)CODEOWNERS$/.test(file) || file === 'docs/agent/deliver.md';

const PROTECTED: { path: string; ask: string }[] = [
  { path: '.nibfin.json', ask: 'Add `"tools": { "node": "24.11.0" }` to `.nibfin.json`.' },
  { path: '.nibfin/notes.md', ask: 'Create `.nibfin/notes.md` containing the line `e2e notes`.' },
  { path: '.rulesync/rules/style.md', ask: 'Create `.rulesync/rules/style.md` containing the line `Use two-space indentation.`' },
  { path: '.github/workflows/ci.yml', ask: 'In `.github/workflows/ci.yml`, add a step `- run: echo protected-path-check` after the `node --test` step.' },
  { path: 'docs/agent/deliver.md', ask: 'Append the line `Prefer small commits.` to `docs/agent/deliver.md`.' },
];

export const protectedPaths: Scenario = lifecycle({
  id: 'protected-paths',
  concurrent: true,
  rules: ['R3.46', 'R3.47'],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    const filed: { n: number; path: string }[] = [];
    try {
      await k.baseline();
      const owner = await k.owner();
      for (const p of PROTECTED) {
        const i = await k.file(exec, { scenario: 'protected-paths', title: `Change ${p.path}`, body: `${p.ask} Change nothing else.\n\n_This Issue is an automated nibfin-e2e fixture._`, labels: ['scope'], assignees: [owner.login] });
        filed.push({ n: i.number, path: p.path });
      }
      for (const f of filed) {
        await k.obs.until(`#${f.n} (${f.path}) to stop with pending and a comment`, async (s) => {
          if (!k.labels(s, exec, f.n).includes('pending')) return undefined;
          return (await k.obs.comments(exec, f.n)).some((x) => markerOf(x.body)) ? true : undefined;
        }, DEADLINE.delivery, k.show(exec, f.n));
      }
      const branches = (await k.gh.list<{ name: string }>(`/repos/${exec}/branches`)).map((b) => b.name);
      const s = await k.obs.fresh();
      for (const f of filed) {
        c.check('R3.47', k.issue(s, exec, f.n)?.state === 'open', `#${f.n} (${f.path}) was closed`);
        const prs = (s.pulls.get(exec) ?? []).filter((p) => isIssueBranch(p.head.ref, f.n));
        c.check('R3.47', prs.length === 0, `#${f.n} (${f.path}) has PR ${prs.map((p) => `#${p.number}`).join(', ')}`);
        for (const b of branches.filter((x) => isIssueBranch(x, f.n))) {
          const { data } = await k.gh.rest<{ files?: { filename: string }[] }>('GET', `/repos/${exec}/compare/main...${b}`);
          const touched = (data.files ?? []).filter((x) => isProtected(x.filename));
          c.check('R3.46', touched.length === 0, `branch ${b} of #${f.n} changes ${touched.map((x) => x.filename).join(', ')}`);
        }
      }
      return c.outcome(`all ${filed.length} protected-path requests stopped with pending before any push of the path or a PR`);
    } finally {
      await k.pauseOpen(exec, filed.map((f) => f.n));
    }
  },
});

/** Completed deliver agent jobs of the Issue whose log names the fix reason. */
async function fixJobs(k: Kit, s: Snapshot, n: number, reason: string): Promise<(Job & { stage: Stage; run: Run })[]> {
  const out: (Job & { stage: Stage; run: Run })[] = [];
  for (const j of await k.agentJobs(s, k.exec, n, ['deliver'])) {
    if (j.status === 'completed' && reasonOf(await k.obs.log(k.exec, j.id)) === reason) out.push(j);
  }
  return out;
}

export const fixLoops: Scenario = lifecycle({
  id: 'fix-loops',
  concurrent: true,
  rules: ['R3.17', 'R3.20', 'R3.21', 'R3.24', 'R3.25', 'R3.30', 'R3.31', 'R3.37', 'R3.38'],
  async run(k) {
    const c = new Checks();
    const { exec } = k;
    let f: Issue | undefined;
    try {
      await k.baseline();
      const owner = await k.owner();
      const slug = k.slug('f');
      await k.hookRules('ci', [{ when: `src/${slug}.js`, event: 'pull_request', require: { file: 'CHANGELOG.md', contains: slug } }]);
      await k.hookRules('cd', [{ when: `src/${slug}.js`, event: 'push', require: { file: 'README.md', contains: slug } }]);
      f = await k.file(exec, { scenario: 'fix-loops', title: 'Add cube', body: changeRequest(slug, 'cube', 'returns its argument cubed'), labels: ['scope'], assignees: [owner.login] });
      const n = f.number;
      const branch = `nibfin/issue-${n}`;
      const show = k.show(exec, n);
      const headsAfter: { reason: string; prHead: string; branchHead: string }[] = [];
      const readHeads = async (reason: string, pr: number) => {
        const { data: p } = await k.gh.rest<Pull>('GET', `/repos/${exec}/pulls/${pr}`);
        const { data: b } = await k.gh.rest<{ commit: { sha: string } }>('GET', `/repos/${exec}/branches/${branch}`, undefined, [404]);
        headsAfter.push({ reason, prHead: p.head.sha, branchHead: b?.commit?.sha ?? '(deleted)' });
      };

      // 1: PR CI fails, then a ci-failure Deliver (R3.21, R3.37).
      const pr1 = await k.obs.until('F\'s first PR', (s) => s.pulls.get(exec)?.find((p) => p.head.ref === branch), DEADLINE.delivery, show);
      await k.obs.until('PR CI to fail on F\'s first PR', async (s) => {
        const pr = s.pulls.get(exec)?.find((p) => p.number === pr1.number);
        if (!pr) return undefined;
        const t = (await k.obs.checkRuns(exec, pr.head.sha)).find((x) => x.name === 'test');
        return t?.status === 'completed' && t.conclusion === 'failure' ? true : undefined;
      }, DEADLINE.stage, show);
      const ciFix = await k.obs.until('a deliver job with REASON ci-failure', async (s) => (await fixJobs(k, s, n, 'ci-failure'))[0], DEADLINE.stage, show);
      await readHeads('ci-failure', pr1.number);

      // 2: a harness commit the review must reject (R3.24, R3.25).
      const { data: now1 } = await k.gh.rest<Pull>('GET', `/repos/${exec}/pulls/${pr1.number}`);
      let fixesExpected = 3;
      if (now1.merged_at) c.notExercised('R3.24', `PR #${pr1.number} merged before the harness commit`);
      else {
        const sha = await k.commitFiles(
          exec,
          branch,
          {
            'src/sum.js': '/** Adds two numbers. */\nexport function sum(a, b) {\n  return a - b;\n}\n',
            'test/sum.test.js': "import { equal } from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from '../src/sum.js';\n\ntest('sum adds two numbers', () => {\n  equal(sum(5, 3), 2);\n});\n",
          },
          'Make sum subtract',
        );
        const at = k.now();
        fixesExpected = 4;
        await k.obs.until('a marked review comment on F\'s PR after the harness commit', async () => {
          const cs = await k.obs.comments(exec, pr1.number);
          return cs.some((x) => markerOf(x.body) && time(x.updated_at) >= at) ? true : undefined;
        }, DEADLINE.stage, show);
        const reviewFix = await k.obs.until('a deliver job with REASON review', async (s) => (await fixJobs(k, s, n, 'review')).find((j) => time(j.started_at) >= at), DEADLINE.stage, show);
        await readHeads('review', pr1.number);
        const merged1 = await k.obs.until('F\'s first PR to merge', (s) => s.pulls.get(exec)?.find((p) => p.number === pr1.number && p.merged_at), DEADLINE.stage, show);
        const s = await k.obs.fresh();
        c.check('R3.24', merged1.head.sha !== sha && (await k.obs.descends(exec, sha, merged1.head.sha)), `the merged head ${merged1.head.sha} is the harness commit or does not follow it`);
        c.check('R3.24', ((await k.fileOn(exec, merged1.head.sha, 'src/sum.js')) ?? '').includes('a + b'), 'the merged head still subtracts in sum');
        const reviews = (await k.agentJobs(s, exec, n, ['review'])).filter((j) => time(j.started_at) >= time(reviewFix.completed_at) && time(j.started_at) < time(merged1.merged_at));
        c.check('R3.25', reviews.length > 0, 'no review ran on the head that merged (after the review fix)');

        // 3: R3.20 over the two fix runs that started while PR1 was open. Only this
        // Issue's branches are F's writes; other Issues push to their own in parallel.
        const acts = (await k.obs.activity(exec)).filter((a) => isIssueBranch(a.ref, n));
        const win = (j: Job, reason: string) => ({ start: time(j.started_at), end: time(j.completed_at), reason });
        const pulls = (await k.obs.pullsByHead(exec, branch)).map((p) => p.number);
        c.none('R3.20', fixPushProblems({ branch, prNumber: pr1.number, windows: [win(ciFix, 'ci-failure'), win(reviewFix, 'review')], activity: acts, headsAfter, pullsForBranch: pulls }));
      }

      // 4: CD fails after the merge: a cd-failure Deliver from the latest main opens a new PR (R3.30).
      const merged = (await k.obs.pullsByHead(exec, branch)).find((p) => p.merged_at);
      const mergeSha = merged?.merge_commit_sha;
      if (!merged || !mergeSha) throw new Error(`F's first PR did not merge: ${await k.summary(await k.obs.fresh(), exec, n)}`);
      const cd = await k.obs.until('CD of F\'s merge to fail', (s) => s.runs.find((r) => r.repo === exec && r.name === 'CD' && r.event === 'push' && r.head_sha === mergeSha && r.status === 'completed'), DEADLINE.event, show);
      c.check('R3.30', cd.conclusion === 'failure', `CD of F's merge concluded ${String(cd.conclusion)}, expected the README rule to fail it`);
      await k.obs.until('a deliver job with REASON cd-failure', async (s) => (await fixJobs(k, s, n, 'cd-failure'))[0], DEADLINE.stage, show);
      const pr2 = await k.obs.until('a new fix PR for F', (s) => s.pulls.get(exec)?.find((p) => p.number !== merged.number && isIssueBranch(p.head.ref, n)), DEADLINE.stage, show);
      c.check('R3.30', time(pr2.created_at) > time(cd.updated_at) && pr2.base.ref === 'main', `PR #${pr2.number} is not a new PR against main after the CD failure`);
      const done = await k.obs.until('F to close with delivered', (s) => k.delivered(s, exec, n), DEADLINE.delivery, show);
      const s = await k.obs.fresh();
      const pr2m = s.pulls.get(exec)?.find((p) => p.number === pr2.number);
      c.check('R3.30', !!pr2m?.merged_at, `the fix PR #${pr2.number} did not merge`);
      const cd2 = s.runs.find((r) => r.repo === exec && r.name === 'CD' && r.head_sha === pr2m?.merge_commit_sha);
      c.check('R3.31', cd2?.conclusion === 'success', `CD of the fix PR's merge is ${String(cd2?.status)}/${String(cd2?.conclusion)}`);
      if (pr2m) c.none('R3.31', closingProblems(await k.obs.comments(exec, n), [merged, pr2m]));
      const fixes = (await k.agentJobs(s, exec, n, ['deliver'])).length;
      c.check('R3.38', fixes >= fixesExpected, `${fixes} deliver jobs; expected the first and ${fixesExpected - 1} fixes`);

      // 5: every branch of F is deleted only after closure (R3.17).
      const deletions = await k.obs.until('F\'s branches to be deleted', async () => {
        const d = (await k.obs.activity(exec, { type: 'branch_deletion' })).filter((x) => isIssueBranch(x.ref, n));
        return d.length ? d : undefined;
      }, DEADLINE.event, show);
      for (const d of deletions) c.check('R3.17', time(d.timestamp) >= time(done.closed_at), `${d.ref} was deleted at ${d.timestamp}, before F closed at ${String(done.closed_at)}`);
      return c.outcome(`#${n}: PR CI, review and CD failures each led to a Deliver fix with its reason, and F was delivered (PRs #${merged.number}, #${pr2.number})`);
    } finally {
      await k.pauseOpen(exec, [f?.number]);
    }
  },
});
