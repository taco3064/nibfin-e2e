import type { KitFor } from './lib/kit.ts';
import type { Scenario } from '../src/types.ts';
import { Checks, excerpt } from './lib/checks.ts';
import { close, comments, labels, prepareFixture } from './lib/fixture.ts';
import { causeCodes, initEvents } from './lib/joblog.ts';
import { runFirstJob } from './lib/single.ts';
import { DEADLINE } from './lib/waits.ts';

/** Proposal R6.3 (and R6.1 on Windows): with limits off, the host memory check sets pending when memory is short. */
export function hostMemoryCheck(kitFor: KitFor): Scenario {
  return {
    id: 'host-memory-check',
    rules: ['R6.1', 'R6.3'],
    platforms: ['linux', 'windows'],
    requires: ['nibfin'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const repo = kit.sandbox.execution;
      const c = new Checks(kit.secrets());
      // No .nibfin.json, so no config or tool step can stop the Job first.
      await prepareFixture(kit, repo, { files: [], variables: { NIBFIN_CONTAINER_LIMITS: 'off', NIBFIN_MEMORY: '1024g' } });
      let n: number | undefined;
      try {
        const job = await runFirstJob(kit, repo, { title: 'e2e host memory check: add double(n)', file: 'host-memory-check', deadlineMs: DEADLINE.rejected, stage: 'memory-checked', onOpen: (i) => (n = i) });
        n = job.issue;
        const p = job.projection;
        c.hold('R6.1', 'a labelled Podman container ran the Job', true, p ? `image ${p.imageName}` : 'started and ended before it could be inspected');
        if (p) c.hold('R6.3', 'with limits off the container has no memory or CPU limit', p.memory === 0 && p.nanoCpus === 0 && p.cpuQuota === 0, JSON.stringify({ memory: p.memory, nanoCpus: p.nanoCpus, cpuQuota: p.cpuQuota }));
        const l = await labels(kit, repo, n);
        const comment = (await comments(kit, repo, n)).map((x) => x.body).join('\n');
        c.hold('R6.3', 'the Issue gets pending', l.includes('pending'), l.join(', '));
        c.hold('R6.3', 'a comment explains the host memory shortage with a cause code', /memory/i.test(comment) && causeCodes(comment).length > 0, excerpt(comment, 300, kit.secrets()) || 'no comment');
        c.hold('R6.3', 'no agent ran', job.log !== undefined && initEvents(job.log.text).length === 0 && !l.includes('shaped'), job.logError ?? 'checked the Job log');
      } finally {
        if (n !== undefined) await close(kit, repo, n).catch(() => {});
      }
      return c.outcome();
    },
  };
}
