// Proposal R9.48: the site's deploy workflows run on push, so R3.34 counts them as CD.
import { check, deployProblems } from '../dashboard/checks.ts';
import { defineScenario } from '../dashboard/support.ts';

const REPO = 'taco3064/gh-nibfin';

export const siteDeployOnPush = defineScenario({
  id: 'site-deploy-on-push',
  rules: ['R9.48'],
  async run(ctx) {
    const gh = ctx.github;
    const { data } = await gh.rest<{ workflows: { id: number; name: string; path: string }[] }>('GET', `/repos/${REPO}/actions/workflows?per_page=100`);
    const pick = (re: RegExp) => data.workflows.find((w) => re.test(w.path.replace(/^.*\//, '')));
    const deploys = [pick(/^(website|pages|site)\.ya?ml$/i), pick(/^worker\.ya?ml$/i)];
    check(deploys.every(Boolean), 'R9.48', 'a Pages and a Worker deploy workflow in gh-nibfin', data.workflows.map((w) => w.path).join(', '));
    const problems: string[] = [];
    const notes: string[] = [];
    for (const w of deploys as { id: number; path: string }[]) {
      const file = await gh.rest<{ content: string }>('GET', `/repos/${REPO}/contents/${w.path}?ref=main`);
      const yaml = Buffer.from(file.data.content, 'base64').toString('utf8');
      const runs = await gh.rest<{ workflow_runs: { event: string; head_branch: string; head_sha: string }[] }>('GET', `/repos/${REPO}/actions/workflows/${w.id}/runs?branch=main&per_page=50`);
      problems.push(...deployProblems(w.path, yaml, runs.data.workflow_runs));
      notes.push(`${w.path}: ${runs.data.workflow_runs.filter((r) => r.event === 'push').length} push runs on main`);
    }
    check(!problems.length, 'R9.48', 'each deploy workflow triggered by push to main, with a push run for every main commit it ran on', problems.join('; '));
    return notes.join('; ');
  },
});
