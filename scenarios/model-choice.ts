import type { KitFor } from './lib/kit.ts';
import type { Outcome, Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import { OVERRIDE_MARKER, OVERRIDE_TEXT, PROBE_FILE, json } from './lib/files.ts';
import { close, comments, labels, prepareFixture } from './lib/fixture.ts';
import { initEvents, stageJob } from './lib/joblog.ts';
import { message } from './lib/kit.ts';
import type { Kit } from './lib/kit.ts';
import { parseProbe } from './lib/probe.ts';
import { localRunners } from './lib/runners.ts';
import { editRunnerEnv } from './lib/runner-env.ts';
import { runFirstJob } from './lib/single.ts';
import type { FirstJob } from './lib/single.ts';
import { DEADLINE, remoteWait } from './lib/waits.ts';

/** The slot whose `.env` gets NIBFIN_MODEL; a constant, never taken from GitHub output. */
const SLOT = 'claude-1';

/** Restarts the slot's user service and waits until its registration is online again. */
async function restart(kit: Kit, slot: string): Promise<void> {
  const r = await kit.exec(['systemctl', '--user', 'restart', `nibfin-runner-${slot}.service`]);
  if (r.code !== 0) throw new Error(`restarting nibfin-runner-${slot}.service exited ${r.code}: ${r.stderr.trim().slice(-1000)}`);
  await remoteWait(kit, `Runner ${slot} to be online after its restart`, DEADLINE.runnerOnline, 10_000, async () => {
    const runner = (await localRunners(kit.github, kit.sandbox.execution)).find((x) => x.slot === slot);
    return runner?.status === 'online' ? true : undefined;
  });
}

/** Maps each Job to its Runner slot from the jobs API `runner_name` (see runnerSlot). */
async function slotOf(kit: Kit, job: FirstJob): Promise<string> {
  if (job.log) return job.log.job.slot;
  const p = job.projection;
  if (!p?.runId) throw new Error(`fixture #${job.issue}: ${job.logError ?? 'no run id'}`);
  return (await stageJob(kit, p.runRepo ?? kit.sandbox.execution, p.runId)).slot;
}

/** Proposal R6.26, R6.27, R6.28, R7.2 (absent), R7.6 (override). */
export function modelChoice(kitFor: KitFor): Scenario {
  return {
    id: 'model-choice',
    rules: ['R6.26', 'R6.27', 'R6.28', 'R7.2', 'R7.6'],
    platforms: ['linux'],
    requires: ['nibfin'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const { execution, peer } = kit.sandbox;
      const opened: [string, number][] = [];
      const c = new Checks(kit.secrets());
      const body = async (): Promise<Outcome> => {
        await prepareFixture(kit, execution, {
          files: [
            { path: '.nibfin.json', content: json({ skills: { shape: { mode: 'override', path: '.nibfin/skills/shape-override.md' } } }) },
            { path: '.nibfin/skills/shape-override.md', content: OVERRIDE_TEXT },
            PROBE_FILE,
          ],
          variables: { NIBFIN_MODEL: 'haiku' },
        });
        await prepareFixture(kit, peer, { files: [], variables: { NIBFIN_MODEL: 'haiku' } });
        editRunnerEnv(kit.env, SLOT, 'NIBFIN_MODEL', 'sonnet');
        await restart(kit, SLOT);

        const run = (repo: string) =>
          runFirstJob(kit, repo, { title: 'e2e model choice: add double(n)', file: `model-choice-${repo.split('/')[1]}`, deadlineMs: DEADLINE.shape, stage: 'Shape', pause: true, onOpen: (n) => opened.push([repo, n]) });
        // Both Jobs are awaited, also when one fails, so neither runs on while the Runner is restored.
        const settled = await Promise.allSettled([run(execution), run(peer)]);
        const failedRuns = settled.flatMap((s) => (s.status === 'rejected' ? [message(s.reason)] : []));
        if (failedRuns.length) throw new Error(failedRuns.join('; '));
        const [ex, pe] = settled.map((s) => (s as PromiseFulfilledResult<FirstJob>).value) as [FirstJob, FirstJob];
        const slots = { ex: await slotOf(kit, ex), pe: await slotOf(kit, pe) };
        if (slots.ex === slots.pe) return { status: 'failed', reason: `both Jobs landed on one Runner (${slots.ex}), so the per-Runner model cannot be told apart` };
        const model = (j: FirstJob) => initEvents(j.log?.text ?? '')[0]?.model;
        const bySlot = new Map([[slots.ex, ex], [slots.pe, pe]]);
        const m1 = model(bySlot.get('claude-1') as FirstJob);
        const m2 = model(bySlot.get('claude-2') as FirstJob);
        c.hold('R6.26', 'the Runner whose .env sets NIBFIN_MODEL=sonnet ran a Sonnet model', /sonnet/i.test(m1 ?? ''), m1 ?? 'no init event');
        c.hold('R6.27', 'the Runner without NIBFIN_MODEL ran the Claude default, Opus', /opus/i.test(m2 ?? ''), m2 ?? 'no init event');
        c.hold('R6.28', 'the repository variable NIBFIN_MODEL=haiku chose no model', ![m1, m2].some((m) => /haiku/i.test(m ?? '')), `${m1 ?? '-'}, ${m2 ?? '-'}`);

        const line = parseProbe((await comments(kit, execution, ex.issue)).map((x) => x.body).join('\n'))?.get('first_instruction_line')?.[0];
        c.hold('R7.6', 'override replaces the built-in Shape text entirely', line?.trim() === OVERRIDE_MARKER, line ?? 'no first_instruction_line');
        const peerLabels = await labels(kit, peer, pe.issue);
        c.hold('R7.2', 'without .nibfin.json the Job ran its agent with the defaults', initEvents(pe.log?.text ?? '').length > 0 && peerLabels.includes('shaped'), `${pe.logError ?? 'log read'}; labels ${peerLabels.join(', ')}`);
        return c.outcome();
      };
      const outcome = await body().catch((error: unknown): Outcome => ({ status: 'failed', reason: message(error) }));
      // Restore the Runner whatever happened; a failed restore fails the scenario.
      let restore: string | undefined;
      try {
        editRunnerEnv(kit.env, SLOT, 'NIBFIN_MODEL', undefined);
        await restart(kit, SLOT);
      } catch (error) {
        restore = `restoring Runner ${SLOT} failed: ${message(error)}`;
      }
      for (const [repo, n] of opened) await close(kit, repo, n).catch(() => {});
      if (restore) return { status: 'failed', reason: outcome.status === 'failed' ? `${restore}; the scenario had also failed: ${outcome.reason}` : restore };
      return outcome;
    },
  };
}
