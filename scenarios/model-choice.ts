import type { KitFor } from './lib/kit.ts';
import type { Outcome, Scenario } from '../src/types.ts';
import { markerOf } from './lifecycle/analysis.ts';
import { SHAPE_MARKER } from './lifecycle/marks.ts';
import { Checks, excerpt } from './lib/checks.ts';
import { OVERRIDE_MARKER, OVERRIDE_TEXT, PROBE_FILE, json } from './lib/files.ts';
import { close, comments, labels, prepareFixture } from './lib/fixture.ts';
import type { Comment } from './lib/fixture.ts';
import { initEvents, stageJob } from './lib/joblog.ts';
import { message } from './lib/kit.ts';
import type { Kit } from './lib/kit.ts';
import { first, parseProbe } from './lib/probe.ts';
import { runnerCount } from './lib/github.ts';
import { localRunners, setSlotServices, slotsOf } from './lib/runners.ts';
import { editRunnerEnv } from './lib/runner-env.ts';
import { runFirstJob } from './lib/single.ts';
import type { FirstJob } from './lib/single.ts';
import { DEADLINE, remoteWait } from './lib/waits.ts';

/** The slot whose `.env` gets NIBFIN_MODEL; a constant, never taken from GitHub output. */
const SLOT = 'claude-1';

/**
 * The two slots whose Jobs the scenario compares. With more Runners on the host, the slots
 * after these are stopped while it runs, so its two Jobs land on claude-1 and claude-2.
 */
const COMPARED = ['claude-1', 'claude-2'];

/** Restarts the slot's user service and waits until its registration is online again. */
async function restart(kit: Kit, slot: string, count: number): Promise<void> {
  const r = await kit.exec(['systemctl', '--user', 'restart', `nibfin-runner-${slot}.service`]);
  if (r.code !== 0)
    throw new Error(`restarting nibfin-runner-${slot}.service exited ${r.code}: ${r.stderr.trim().slice(-1000)}`);
  await remoteWait(kit, `Runner ${slot} to be online after its restart`, DEADLINE.runnerOnline, 10_000, async () => {
    const runner = (await localRunners(kit.github, kit.sandbox.execution, count)).find((x) => x.slot === slot);
    return runner?.status === 'online' ? true : undefined;
  });
}

/** Starts the stopped slots again and waits until every Runner the host has reads online. */
async function startStopped(kit: Kit, slots: string[], count: number): Promise<void> {
  await setSlotServices(kit.exec, kit.env, 'start', slots);
  let last = '';
  await remoteWait(kit, `all ${count} Runners to be online after starting ${slots.join(', ')}`, DEADLINE.runnerOnline, 10_000, async () => {
    const rs = await localRunners(kit.github, kit.sandbox.execution, count);
    last = rs.filter((r) => r.status !== 'online').map((r) => `${r.slot} is ${r.status}`).join('; ');
    return last ? undefined : true;
  }).catch((error: unknown) => {
    throw new Error(last ? `${message(error)}: ${last}` : message(error), { cause: error });
  });
}

/** Maps each Job to its Runner slot from the jobs API `runner_name` (see runnerSlot). */
async function slotOf(kit: Kit, job: FirstJob): Promise<string> {
  if (job.log) return job.log.job.slot;
  const p = job.projection;
  if (!p?.runId) throw new Error(`fixture #${job.issue}: ${job.logError ?? 'no run id'}`);
  return (await stageJob(kit, p.runRepo ?? kit.sandbox.execution, p.runId)).slot;
}

/**
 * Judges Proposal R7.6 from the comments as read when `shaped` was observed: the probe's
 * first_instruction_line in the Nibfin Shape comment (marker `<!-- nibfin:shape… -->`),
 * or, without one, in the latest comment with an e2e-probe block, saying so. A failure
 * names the comment read and which case happened; only a bounded, redacted excerpt of the
 * line or of the key names is quoted.
 */
export function shapeProbeLine(cs: Comment[], secrets: string[]): { ok: boolean; detail: string } {
  const shapeAt = cs.findLastIndex((x) => SHAPE_MARKER.test(markerOf(x.body) ?? ''));
  let at = shapeAt;
  let source = 'the Shape comment';
  if (shapeAt < 0) {
    at = cs.findLastIndex((x) => parseProbe(x.body) !== undefined);
    if (at < 0)
      return { ok: false, detail: `no Shape comment and no comment with an e2e-probe block (${cs.length} comments)` };
    source = `no Shape comment; fallback: comment #${at + 1} of ${cs.length}, the latest with an e2e-probe block`;
  }
  const probe = parseProbe(cs[at]?.body ?? '');
  if (!probe) return { ok: false, detail: 'the Shape comment has no e2e-probe block' };
  const line = first(probe, 'first_instruction_line');
  if (line === undefined)
    return {
      ok: false,
      detail: `the e2e-probe block in ${source} has no first_instruction_line; its keys: ${excerpt([...probe.keys()].join(', ') || 'none', 200, secrets)}`,
    };
  if (line.trim() === OVERRIDE_MARKER)
    return { ok: true, detail: `${source}: first_instruction_line is the override marker` };
  return { ok: false, detail: `first_instruction_line in ${source} is "${excerpt(line, 120, secrets)}"` };
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
      const count = runnerCount(kit.facts);
      const extra = slotsOf(count).filter((s) => !COMPARED.includes(s));
      let stopped = false;
      const body = async (): Promise<Outcome> => {
        await prepareFixture(kit, execution, {
          files: [
            {
              path: '.nibfin.json',
              content: json({ skills: { shape: { mode: 'override', path: '.nibfin/skills/shape-override.md' } } }),
            },
            { path: '.nibfin/skills/shape-override.md', content: OVERRIDE_TEXT },
            PROBE_FILE,
          ],
          variables: { NIBFIN_MODEL: 'haiku' },
        });
        await prepareFixture(kit, peer, { files: [], variables: { NIBFIN_MODEL: 'haiku' } });
        if (extra.length) {
          stopped = true;
          await setSlotServices(kit.exec, kit.env, 'stop', extra);
        }
        editRunnerEnv(kit.env, SLOT, 'NIBFIN_MODEL', 'sonnet');
        await restart(kit, SLOT, count);

        const run = (repo: string) =>
          runFirstJob(kit, repo, {
            title: 'e2e model choice: add double(n)',
            file: `model-choice-${repo.split('/')[1]}`,
            deadlineMs: DEADLINE.shape,
            stage: 'Shape',
            pauseWhenShaped: true,
            onOpen: (n) => opened.push([repo, n]),
          });
        // Both Jobs are awaited, also when one fails, so neither runs on while the Runner is restored.
        const settled = await Promise.allSettled([run(execution), run(peer)]);
        const failedRuns = settled.flatMap((s) => (s.status === 'rejected' ? [message(s.reason)] : []));
        if (failedRuns.length) throw new Error(failedRuns.join('; '));
        const [ex, pe] = settled.map((s) => (s as PromiseFulfilledResult<FirstJob>).value) as [FirstJob, FirstJob];
        const slots = { ex: await slotOf(kit, ex), pe: await slotOf(kit, pe) };
        if (slots.ex === slots.pe)
          return {
            status: 'failed',
            reason: `both Jobs landed on one Runner (${slots.ex}), so the per-Runner model cannot be told apart`,
          };
        const model = (j: FirstJob) => initEvents(j.log?.text ?? '')[0]?.model;
        const bySlot = new Map([
          [slots.ex, ex],
          [slots.pe, pe],
        ]);
        const m1 = model(bySlot.get('claude-1') as FirstJob);
        const m2 = model(bySlot.get('claude-2') as FirstJob);
        c.hold(
          'R6.26',
          'the Runner whose .env sets NIBFIN_MODEL=sonnet ran a Sonnet model',
          /sonnet/i.test(m1 ?? ''),
          m1 ?? 'no init event',
        );
        c.hold(
          'R6.27',
          'the Runner without NIBFIN_MODEL ran the Claude default, Opus',
          /opus/i.test(m2 ?? ''),
          m2 ?? 'no init event',
        );
        c.hold(
          'R6.28',
          'the repository variable NIBFIN_MODEL=haiku chose no model',
          ![m1, m2].some((m) => /haiku/i.test(m ?? '')),
          `${m1 ?? '-'}, ${m2 ?? '-'}`,
        );

        // R7.6 reads the comments as they were when shaped was observed; later comments do not count.
        let atShaped = ex.shaped?.comments;
        let readNow = '';
        if (!atShaped) {
          readNow = `comments at shaped unreadable (${ex.shaped?.commentsError ?? 'not captured'}); read now: `;
          atShaped = await comments(kit, execution, ex.issue);
        }
        const r76 = shapeProbeLine(atShaped, kit.secrets());
        c.hold('R7.6', 'override replaces the built-in Shape text entirely', r76.ok, readNow + r76.detail);
        // R7.2 uses the shaped the wait saw; Deliver may lawfully remove it later (Proposal R4.10, R3.39).
        const seen = pe.shaped?.labels ?? [];
        const now = await labels(kit, peer, pe.issue).then(
          (l) => l.join(', ') || 'none',
          (error: unknown) => `unreadable: ${message(error)}`,
        );
        const seenText = seen.join(', ') || 'none';
        c.hold(
          'R7.2',
          'without .nibfin.json the Job ran its agent with the defaults',
          initEvents(pe.log?.text ?? '').length > 0 && seen.includes('shaped'),
          `${pe.logError ?? 'log read'}; labels when shaped was observed: ${seenText}${now === seenText ? '' : `; labels now: ${now}`}`,
        );
        return c.outcome();
      };
      const outcome = await body().catch((error: unknown): Outcome => ({ status: 'failed', reason: message(error) }));
      // Restore the Runners whatever happened; a failed restore fails the scenario.
      const restores: string[] = [];
      try {
        editRunnerEnv(kit.env, SLOT, 'NIBFIN_MODEL', undefined);
        await restart(kit, SLOT, count);
      } catch (error) {
        restores.push(`restoring Runner ${SLOT} failed: ${message(error)}`);
      }
      if (stopped) {
        try {
          await startStopped(kit, extra, count);
        } catch (error) {
          restores.push(`starting Runners ${extra.join(', ')} again failed: ${message(error)}`);
        }
      }
      const restore = restores.join('; ') || undefined;
      for (const [repo, n] of opened) await close(kit, repo, n).catch(() => {});
      if (restore)
        return {
          status: 'failed',
          reason: outcome.status === 'failed' ? `${restore}; the scenario had also failed: ${outcome.reason}` : restore,
        };
      return outcome;
    },
  };
}
