import type { Scenario } from '../../src/types.ts';
import { Check, tail } from '../lib/check.ts';
import { addLabels, createIssue, labelsOf, registrations } from '../lib/github.ts';
import { sleep } from '../lib/wait.ts';

export const pauseResume: Scenario = {
  id: 'pause-resume',
  rules: ['R5.51', 'R5.52'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const gh = ctx.github;
    const repo = ctx.sandbox.execution;
    const n1 = (await createIssue(gh, repo, { title: 'e2e pause 1' })).number;
    const n2 = (await createIssue(gh, repo, { title: 'e2e pause 2' })).number;

    // No --yes and stdin closed: pause and resume ask no confirmation.
    const p = await ctx.ghNibfin(['pause', String(n1), String(n2)]);
    c.that(p.code === 0, 'R5.52', `pause #${n1} #${n2} without --yes exited ${p.code}: ${tail(p)}`);
    for (const n of [n1, n2]) c.that((await labelsOf(gh, repo, n)).includes('pause'), 'R5.51', `#${n} has no pause after gh nibfin pause`);

    await addLabels(gh, repo, n1, ['pending']);
    const r = await ctx.ghNibfin(['resume', String(n1), String(n2)]);
    c.that(r.code === 0, 'R5.52', `resume #${n1} #${n2} without --yes exited ${r.code}: ${tail(r)}`);
    for (const n of [n1, n2]) {
      const labels = await labelsOf(gh, repo, n);
      c.that(!labels.includes('pause') && !labels.includes('pending'), 'R5.51', `#${n} has [${labels.join(', ')}] after gh nibfin resume, expected neither pause nor pending`);
    }
    return c.outcome(`pause and resume of #${n1} and #${n2} in one call each, without confirmation; resume also removed pending`);
  },
};

export const confirmPreview: Scenario = {
  id: 'confirm-preview',
  rules: ['R5.21'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const repo = ctx.sandbox.execution;
    const before = (await registrations(ctx.github, repo)).length;
    const r = await ctx.ghNibfin(['runner', 'add', 'claude', '--count', '1'], { input: 'n\n' });
    c.that((r.stdout + r.stderr).trim() !== '', 'R5.21', 'runner add without --yes showed no plan');
    c.that(/claude|runner/i.test(r.stdout + r.stderr), 'R5.21', `runner add without --yes did not show a plan naming the Runner: ${tail(r, 300)}`);
    // Give a wrongly applied change time to reach GitHub before reading back.
    await sleep(30_000);
    const after = (await registrations(ctx.github, repo)).length;
    c.that(after === before, 'R5.21', `answering "n" to runner add changed the registrations from ${before} to ${after}`);
    return c.outcome(`runner add without --yes showed its plan and, refused, changed nothing (${after} registrations)`);
  },
};
