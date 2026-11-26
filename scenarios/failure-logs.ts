import type { KitFor } from './lib/kit.ts';
import type { Scenario } from '../src/types.ts';
import { Checks, excerpt, freeOfSecrets } from './lib/checks.ts';
import { json } from './lib/files.ts';
import { close, comments, prepareFixture } from './lib/fixture.ts';
import { causeCodes } from './lib/joblog.ts';
import { imageDigest } from './lib/observed-facts.ts';
import { runFirstJob } from './lib/single.ts';
import { DEADLINE } from './lib/waits.ts';

/** uv's own output about the unknown version (the exact wording is uv's; matched loosely). */
const UV_OUTPUT = /cpython-3\.99\.99|No download found[^\n]*3\.99\.99/i;

/** Proposal R1.14: the lowest-level cause code, child output kept, only credentials masked, a next step. */
export function failureLogs(kitFor: KitFor): Scenario {
  return {
    id: 'failure-logs',
    rules: ['R1.14'],
    platforms: ['linux'],
    requires: ['nibfin'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const repo = kit.sandbox.execution;
      const c = new Checks(kit.secrets());
      await prepareFixture(kit, repo, { files: [{ path: '.nibfin.json', content: json({ tools: { python: '3.99.99' } }) }] });
      let n: number | undefined;
      try {
        const job = await runFirstJob(kit, repo, { title: 'e2e failure logs: add double(n)', file: 'failure-logs', deadlineMs: DEADLINE.rejected, stage: 'rejected', onOpen: (i) => (n = i) });
        n = job.issue;
        const comment = (await comments(kit, repo, n)).map((x) => x.body).join('\n');
        const log = job.log?.text ?? '';
        if (!job.log) c.hold('R1.14', 'the Job log could be read', false, job.logError);
        const shared = causeCodes(comment).filter((code) => log.includes(code));
        const toolCode = shared.find((code) => /TOOL|INSTALL|PYTHON/.test(code));
        c.hold('R1.14', 'the comment and the log carry the same tool cause code', toolCode !== undefined, `comment codes ${causeCodes(comment).join(', ') || 'none'}; shared ${shared.join(', ') || 'none'}`);
        c.hold('R1.14', "uv's own output is kept in the Job log", UV_OUTPUT.test(log), UV_OUTPUT.exec(log)?.[0] ?? 'not found');
        const clean = freeOfSecrets(log + '\n' + comment, kit.secrets()) && job.log?.secretFound !== true;
        c.hold('R1.14', 'no credential appears in the log or the comment', clean, clean ? 'not found' : 'found');
        const digest = imageDigest(ctx);
        const clear = [repo, digest].filter((s) => !log.includes(s));
        if (!new RegExp(`\\b${n}\\b`).test(log)) clear.push(`Issue number ${n}`);
        c.hold('R1.14', 'non-secret values are not masked in the log', job.log !== undefined && clear.length === 0, clear.length ? `missing ${clear.join(', ')}` : 'repository, Issue and digest in clear');
        c.hold('R1.14', 'the comment names the next step', /remove[^\n]*pending|pending[^\n]*remov|gh nibfin \w+|resume/i.test(comment), excerpt(comment, 300, kit.secrets()) || 'no comment');
      } finally {
        if (n !== undefined) await close(kit, repo, n).catch(() => {});
      }
      return c.outcome();
    },
  };
}
