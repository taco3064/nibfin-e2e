import type { ExecResult } from '../../src/host/exec.ts';
import { readHostState } from '../../src/host/hoststate.ts';
import type { HostState } from '../../src/host/hoststate.ts';
import type { Outcome, RunContext, Scenario } from '../../src/types.ts';
import { Check, message, precondition, tail } from '../lib/check.ts';
import { readContainer, watchJobContainers } from '../lib/containers.ts';
import type { ContainerEvent, Watch } from '../lib/containers.ts';
import { TASK_BODY } from '../lib/files.ts';
import { addLabel, close, issueState, labels, openFixture, prepareFixture } from '../lib/fixture.ts';
import { nibfinFacts, openPulls, putFile, readFile, registrations, removeLabel } from '../lib/github.ts';
import { oldCandidates, requireCurrentImage, tagDigest } from '../lib/image.ts';
import type { CommitImage } from '../lib/image.ts';
import { buildOutput, imageLine, jobLog, stageRunsAround } from '../lib/joblog.ts';
import type { RunRef } from '../lib/joblog.ts';
import type { Kit, KitFor } from '../lib/kit.ts';
import { IMAGE } from '../lib/observed-facts.ts';
import { imagesNamed } from '../lib/observed.ts';
import type { LocalImage } from '../lib/observed.ts';
import { DEADLINE, remoteWait } from '../lib/waits.ts';
import { readWorkflow, repin } from '../lib/workflows.ts';
import { hostRun } from './runner-add-setup.ts';

const RULE = 'R5.55';
const CORE = 'taco3064/nibfin-core';
const WORKFLOWS = '.github/workflows';
const SECOND = 1000;
const MIN = 60 * SECOND;

const ref = (digest: string) => `${IMAGE}@${digest}`;
/** Image references that pin a digest; the bare `ghcr.io/taco3064/nibfin` name is not a pin. */
const pins = (text: string) => readWorkflow(text).images.filter((i) => i.includes('@'));

/** main's Nibfin workflow files (`nibfin-*.yml`) and their text. */
async function nibfinWorkflows(kit: Kit, repo: string): Promise<Map<string, string>> {
  const { data } = await kit.github.rest<{ name: string; path: string; type: string }[]>(
    'GET',
    `/repos/${repo}/contents/${WORKFLOWS}?ref=main`,
  );
  const out = new Map<string, string>();
  for (const f of data.filter((x) => x.type === 'file' && /^nibfin-.*\.ya?ml$/.test(x.name))) {
    const file = await readFile(kit.github, repo, f.path);
    if (file) out.set(f.path, file.text);
  }
  return out;
}

/** Every pin on main's Nibfin workflows that is not `want`, as `path: ref`. */
function otherPins(files: Map<string, string>, want: string): string[] {
  return [...files].flatMap(([path, text]) =>
    pins(text)
      .filter((p) => p !== want)
      .map((p) => `${path}: ${p}`),
  );
}

/** User units whose names are new, and files added under /etc/systemd/system. */
function hostAdditions(before: HostState, now: HostState): string[] {
  if (before.platform !== 'linux' || now.platform !== 'linux') return [];
  const had = new Set(before.units.map((u) => u.name));
  return [
    ...now.units.filter((u) => !had.has(u.name)).map((u) => `systemd user unit ${u.name}`),
    ...now.systemFiles.filter((f) => !before.systemFiles.includes(f)).map((f) => `/etc/systemd/system/${f}`),
  ];
}

interface Found {
  dOld: string;
  oldSha: string;
  newSha: string;
}

/** The nearest earlier nibfin-core main image whose attestation verifies (Proposal R5.55, R8.1). */
async function findOld(ctx: RunContext, kit: Kit, dNew: string): Promise<Found | Outcome> {
  const { data: commits } = await kit.github.rest<{ sha: string }[]>(
    'GET',
    `/repos/${CORE}/commits?sha=main&per_page=100`,
  );
  const chain: CommitImage[] = [];
  let picked = oldCandidates(chain, dNew);
  for (const { sha } of commits) {
    chain.push({ sha, digest: await tagDigest(sha, kit.fetch) });
    picked = oldCandidates(chain, dNew);
    if ('older' in picked && picked.older.length >= 3) break;
  }
  if (!('older' in picked)) return precondition(`${RULE}: no earlier signed image of ${IMAGE}: ${picked.reason}`);
  const tried: string[] = [];
  for (const c of picked.older) {
    const v = await ctx.gh(['attestation', 'verify', `oci://${ref(c.digest)}`, '--repo', CORE]);
    if (v.code === 0) return { dOld: c.digest, oldSha: c.sha, newSha: picked.current.sha };
    tried.push(`${c.sha} → ${c.digest}: gh attestation verify exited ${v.code} (${tail(v, 300)})`);
  }
  return precondition(`${RULE}: no earlier image of ${IMAGE} verifies against ${CORE}: ${tried.join('; ')}`);
}

/** The first new open PR (not in `before`, not the fixture's own branch), polled every 10 s. */
async function upgradePr(
  kit: Kit,
  repo: string,
  before: number[],
  branch: string,
  up: () => string | undefined,
): Promise<number[]> {
  return remoteWait(kit, 'gh nibfin upgrade --yes to open a PR', 10 * MIN, 10 * SECOND, async () => {
    const list = async () =>
      (await openPulls(kit.github, repo))
        .filter((p) => !before.includes(p.number) && p.head.ref !== branch)
        .map((p) => p.number);
    // Read whether the command ended before listing, so a PR it opened just before ending is seen.
    const ended = up();
    const opened = await list();
    if (opened.length) return opened;
    if (ended) throw new Error(`gh nibfin upgrade --yes ${ended} without opening a PR on ${repo}`);
    return undefined;
  });
}

export function imageSwitch(kitFor: KitFor): Scenario {
  return {
    id: 'image-switch',
    rules: [RULE],
    platforms: ['linux'],
    requires: ['nibfin'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const c = new Check();
      const gh = kit.github;
      const repo = kit.sandbox.execution;
      const { imageDigest: dNew, runnerCount: runners } = nibfinFacts(ctx);

      let n: number | undefined;
      let watch: Watch | undefined;
      let startPulls: number[] = [];
      let originals = new Map<string, string>();
      let dOld: string | undefined;
      // `gh nibfin upgrade --yes`, visible to teardown so it ends before the Runner check (R5.40).
      let up: Promise<ExecResult | undefined> | undefined;
      let upEnded: string | undefined;
      let upJudged = false;
      let result: Outcome;
      try {
        result = await (async (): Promise<Outcome> => {
          // 1. Start: quiesce and reset main to the init baseline, which pins D_new.
          await prepareFixture(kit, repo, { files: [] });
          const moved = await requireCurrentImage(dNew, kit.fetch);
          if (moved) return moved;
          const hostBefore = await readHostState(hostRun(ctx), 'linux');
          startPulls = (await openPulls(gh, repo)).map((p) => p.number);

          // 2. D_old: the nearest earlier signed image.
          const found = await findOld(ctx, kit, dNew);
          if ('status' in found) return found;
          dOld = found.dOld;
          const old = dOld;

          // 3. Pin the old image on main: the state before an upgrade.
          originals = await nibfinWorkflows(kit, repo);
          const pinned = [...originals].filter(([, text]) => pins(text).includes(ref(dNew)));
          if (!pinned.length) return precondition(`${RULE}: no nibfin-*.yml on ${repo} main pins ${ref(dNew)}`);
          const odd = otherPins(originals, ref(dNew));
          if (odd.length) return precondition(`${RULE}: ${repo} main pins other images: ${odd.join(', ')}`);
          for (const [path, text] of pinned)
            await putFile(gh, repo, path, repin(text, dNew, old).text, `nibfin-e2e: pin the previous image (${RULE})`);
          const readBack = await nibfinWorkflows(kit, repo);
          const notOld = otherPins(readBack, ref(old));
          if (notOld.length)
            return precondition(`${RULE}: after pinning ${ref(old)}, ${repo} main still pins ${notOld.join(', ')}`);

          // 4. The old Job.
          const since = new Date(kit.now() - MIN).toISOString();
          const issue = await openFixture(kit, repo, 'e2e image switch: add double(n)', TASK_BODY);
          n = issue;
          const branch = `nibfin/issue-${issue}`;
          const imagesAt = new Map<string, LocalImage[] | string>();
          watch = watchJobContainers(kit, repo, issue, async (e: ContainerEvent) => {
            imagesAt.set(e.id, await imagesNamed(kit).catch((error: unknown) => message(error)));
          });
          const w = watch;
          const oldStart = await w.started(
            1,
            DEADLINE.shape,
            `the first stage Job container of ${repo}#${issue} to start`,
          );
          const oldId = oldStart.id;
          const oldP = await w.projection(oldId);
          if (
            !c.that(
              oldP?.imageName === ref(old),
              RULE,
              `container ${oldId} of the first stage Job runs ${oldP?.imageName ?? 'an image not read (gone at once)'}, expected ${ref(old)} pinned on main`,
            )
          ) {
            return c.outcome('');
          }
          const oldRunId = oldP?.runId;
          const runRepo = oldP?.runRepo ?? repo;
          if (!oldRunId) return precondition(`${RULE}: container ${oldId} carries no NIBFIN_RUN_ID`);

          // 5. Upgrade while it runs.
          const moved2 = await requireCurrentImage(dNew, kit.fetch);
          if (moved2) return moved2;
          up = ctx.ghNibfin(['upgrade', '--yes']).then(
            (r) => ((upEnded = `exited ${r.code}`), r),
            (error: unknown) => ((upEnded = `failed: ${message(error)}`), undefined),
          );
          const opened = await upgradePr(kit, repo, startPulls, branch, () => upEnded);
          if (
            !c.that(
              opened.length === 1,
              RULE,
              `gh nibfin upgrade --yes opened ${opened.length} PRs (${opened.map((x) => `#${x}`).join(', ')}), expected 1`,
            )
          ) {
            await up;
            upJudged = true;
            return c.outcome('');
          }
          const pr = opened[0] as number;
          const beforeMerge = await readContainer(kit.exec, oldId);
          if (beforeMerge === 'gone')
            return precondition(
              `${RULE}: the D_old Job (container ${oldId}, run ${oldRunId}) ended before upgrade PR #${pr} merged`,
            );
          const { data: prData } = await gh.rest<{ head: { sha: string } }>('GET', `/repos/${repo}/pulls/${pr}`);
          await gh.rest('PUT', `/repos/${repo}/pulls/${pr}/merge`, { merge_method: 'rebase', sha: prData.head.sha });
          const { data: merged } = await gh.rest<{ merged_at: string | null }>('GET', `/repos/${repo}/pulls/${pr}`);
          if (!merged.merged_at)
            return precondition(`${RULE}: upgrade PR #${pr} reads back unmerged after the rebase merge`);
          const mergedAt = merged.merged_at;
          const afterUpgrade = await nibfinWorkflows(kit, repo);
          const stale = otherPins(afterUpgrade, ref(dNew));
          if (stale.length)
            return precondition(
              `${RULE}: merged upgrade PR #${pr} left main pinning ${stale.join(', ')} instead of ${ref(dNew)} (Proposal R5.38)`,
            );

          // 6. No hot swap: the old container keeps its id and image until it exits.
          const diedSeen = () => w.events.some((e) => e.kind === 'died' && e.id === oldId);
          const loopEnd = kit.now() + DEADLINE.shape;
          let reads = 0;
          for (;;) {
            let read: Awaited<ReturnType<typeof readContainer>>;
            try {
              read = await readContainer(kit.exec, oldId);
            } catch (error) {
              c.fail(RULE, `reading container ${oldId} after merging PR #${pr}: ${message(error)}`);
              break;
            }
            if (read === 'gone') {
              if (!diedSeen()) {
                try {
                  await w.diedAll([oldId], 30 * SECOND, `the died event of container ${oldId}`);
                } catch {
                  c.fail(
                    RULE,
                    `container ${oldId} (run ${oldRunId}) vanished without a died event after ${reads} read(s)`,
                  );
                }
              }
              break;
            }
            reads++;
            if (
              !c.that(
                read.id === oldId && read.image === ref(old),
                RULE,
                `after merging upgrade PR #${pr}, the running container ${oldId} reads as ${read.id} with image ${read.image}, expected ${ref(old)} (hot swap)`,
              )
            )
              break;
            if (diedSeen()) break;
            if (kit.now() >= loopEnd) {
              c.fail(
                RULE,
                `container ${oldId} (run ${oldRunId}) still runs ${Math.round(DEADLINE.shape / MIN)} min after the merge`,
              );
              break;
            }
            await kit.sleep(30 * SECOND);
          }
          // Not one read after the merge saw the container: it was not observed across the merge.
          if (reads === 0 && !c.problems.length)
            return precondition(
              `${RULE}: the D_old Job (container ${oldId}, run ${oldRunId}) ended before it was read after upgrade PR #${pr} merged`,
            );
          const oldLog = await jobLog(kit, runRepo, oldRunId, `image-switch-${issue}-old`);
          const oldLine = imageLine(oldLog.text);
          c.that(
            oldLine?.includes(old) === true,
            RULE,
            `the Job log of run ${oldRunId} (Job ${oldLog.job.id}) says "Nibfin image: ${oldLine ?? 'none'}", expected ${ref(old)}`,
          );
          c.that(
            oldLog.job.conclusion !== null && oldLog.job.conclusion !== 'cancelled',
            RULE,
            `Job ${oldLog.job.id} of run ${oldRunId}, running when PR #${pr} merged, ended ${oldLog.job.conclusion ?? 'without a conclusion'}`,
          );

          // The upgrade: it exits 0 and opened exactly one PR.
          const upResult = await up;
          upJudged = true;
          c.that(
            upResult?.code === 0,
            RULE,
            `gh nibfin upgrade --yes ${upEnded ?? 'did not end'}${upResult ? `: ${tail(upResult)}` : ''}`,
          );
          const extra = (await openPulls(gh, repo))
            .filter((p) => !startPulls.includes(p.number) && p.head.ref !== branch)
            .map((p) => `#${p.number}`);
          c.that(!extra.length, RULE, `besides PR #${pr}, gh nibfin upgrade --yes opened ${extra.join(', ')}`);

          // 7. The next Job: the first stage run created at or after merged_at.
          type ApiRun = RunRef & { status: string };
          const runsSince = () =>
            gh.list<ApiRun>(`/repos/${repo}/actions/runs?created=${encodeURIComponent('>=' + since)}`, 'workflow_runs');
          const findNext = async () => stageRunsAround(await runsSince(), repo, issue, mergedAt).next;
          let wake: string | undefined;
          let next: ApiRun | undefined;
          try {
            next = await remoteWait(
              kit,
              `a stage run of ${repo}#${issue} created at or after ${mergedAt}`,
              DEADLINE.finish,
              15 * SECOND,
              findNext,
            );
          } catch (error) {
            if (kit.signal.aborted) throw error;
            const ls = await labels(kit, repo, issue);
            if (ls.includes('pending')) {
              wake = 'removed pending (Proposal R4.4)';
              await removeLabel(gh, repo, issue, 'pending');
            } else {
              wake = 'removed and re-added scope (Proposal R3.43)';
              await removeLabel(gh, repo, issue, 'scope');
              await addLabel(kit, repo, issue, 'scope');
            }
            kit.log(`${repo}#${issue}: no stage run after the merge; woke it once: ${wake}`);
            try {
              next = await remoteWait(
                kit,
                `a stage run of ${repo}#${issue} created at or after ${mergedAt} after the wake`,
                DEADLINE.shape,
                15 * SECOND,
                findNext,
              );
            } catch (again) {
              if (kit.signal.aborted) throw again;
              c.fail(
                RULE,
                `no stage run of ${repo}#${issue} was created after upgrade PR #${pr} merged at ${mergedAt}, even after one wake (${wake}): ${message(again)}; ${await issueState(kit, repo, issue)}`,
              );
            }
          }
          const beforeRuns = stageRunsAround(await runsSince(), repo, issue, mergedAt).before.map(
            (r) => `${r.id} (${r.display_title}, ${r.created_at})`,
          );
          let nextId: string | undefined;
          let nextNote = '';
          if (next) {
            const target = String(next.id);
            const matches = async (e: ContainerEvent) =>
              e.kind === 'start' && (await w.projection(e.id))?.runId === target;
            const waitEnd = kit.now() + DEADLINE.shape;
            for (let k = 1; ; k++) {
              const e = await w.started(
                k,
                Math.max(waitEnd - kit.now(), 0),
                `the container of run ${target} (the next Job of ${repo}#${issue})`,
              );
              if (await matches(e)) {
                nextId = e.id;
                break;
              }
            }
            await addLabel(kit, repo, issue, 'pause');
            const hostAfter = await readHostState(hostRun(ctx), 'linux');
            const nextP = await w.projection(nextId);
            c.that(
              nextP?.imageName === ref(dNew),
              RULE,
              `container ${nextId} of run ${target}, the next Job after PR #${pr} merged, runs ${nextP?.imageName ?? 'an image not read'}, expected ${ref(dNew)}`,
            );

            // 8. No Core install: D_new reached the host only as a pulled, digest-named image.
            const atOld = imagesAt.get(oldId);
            const atNext = imagesAt.get(nextId);
            if (typeof atOld === 'string' || typeof atNext === 'string' || !atOld || !atNext) {
              c.fail(
                RULE,
                `local images not read at the container starts: ${typeof atOld === 'string' ? atOld : atOld ? 'old read' : 'old missing'}; ${typeof atNext === 'string' ? atNext : atNext ? 'next read' : 'next missing'}`,
              );
            } else {
              const show = (l: LocalImage[]) =>
                l
                  .map((i) => `${i.id.slice(0, 12)} [${i.repoDigests.join(' ') || i.names.join(' ') || 'no name'}]`)
                  .join(', ') || 'none';
              c.that(
                atNext.some((i) => i.repoDigests.includes(ref(dNew))),
                RULE,
                `when run ${target} started, no local image has the repo digest ${ref(dNew)}: ${show(atNext)}`,
              );
              const oldIds = new Set(atOld.map((i) => i.id));
              const gained = atNext.filter((i) => !oldIds.has(i.id));
              const strange = gained.filter((i) => !i.repoDigests.includes(ref(dNew)));
              c.that(
                !strange.length,
                RULE,
                `images that appeared on the host other than the pulled ${ref(dNew)}: ${show(strange)}`,
              );
              const built = atNext.filter((i) => !i.repoDigests.length);
              c.that(
                !built.length,
                RULE,
                `local ${IMAGE} images without a repo digest (built, not pulled): ${show(built)}`,
              );
              if (atOld.some((i) => i.repoDigests.includes(ref(dNew))))
                nextNote = `; ${ref(dNew)} was already on the host when the old Job started (its removal was refused)`;
            }
            const added = hostAdditions(hostBefore, hostAfter);
            c.that(!added.length, RULE, `the host gained ${added.join(', ')} between the start and run ${target}`);

            const died = await w
              .diedAll([nextId], DEADLINE.deliver, `container ${nextId} of run ${target} to end`)
              .then(
                () => true,
                async (error: unknown) => (
                  c.fail(RULE, `${message(error)}; ${await issueState(kit, repo, issue)}`),
                  false
                ),
              );
            if (died) {
              const nextLog = await jobLog(kit, nextP?.runRepo ?? repo, target, `image-switch-${issue}-next`);
              const line = imageLine(nextLog.text);
              c.that(
                line?.includes(dNew) === true,
                RULE,
                `the Job log of run ${target} (Job ${nextLog.job.id} on ${nextLog.job.runnerName}) says "Nibfin image: ${line ?? 'none'}", expected ${ref(dNew)}`,
              );
              const build = buildOutput(nextLog.text);
              c.that(build === undefined, RULE, `the Job log of run ${target} shows an image build: ${build}`);
            }
          }
          const parts = [
            `D_old ${old} (nibfin-core ${found.oldSha}) and D_new ${dNew} (nibfin-core ${found.newSha})`,
            `old container ${oldId} of run ${oldRunId} kept ${ref(old)} over ${reads} read(s) after upgrade PR #${pr} merged at ${mergedAt}`,
            next ? `next container ${nextId ?? 'none'} of run ${next.id} ran ${ref(dNew)}${nextNote}` : 'no next Job',
            `stage runs created before the merge (not judged): ${beforeRuns.join(', ') || 'none'}`,
            `wake: ${wake ?? 'none'}`,
          ];
          return c.outcome(parts.join('; '));
        })();
      } catch (error) {
        const state = n !== undefined && !kit.signal.aborted ? `; ${await issueState(kit, repo, n)}` : '';
        result = { status: 'failed', reason: [...c.problems, `${RULE}: ${message(error)}${state}`].join('; ') };
      }

      // 10. Teardown: each step runs even when an earlier one fails.
      const down: string[] = [];
      const step = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (error) {
          down.push(`teardown: ${what}: ${message(error)}`);
        }
      };
      watch?.stop();
      if (n !== undefined) {
        const issue = n;
        await step(`closing fixture ${repo}#${issue}`, () => close(kit, repo, issue));
      }
      if (up && !upJudged) {
        // An early return or a throw left the upgrade running: it may still open its PR or align
        // (restart) an idle Runner, so wait for it to end, after the fixture is closed and before
        // the new PRs are closed and every Runner is checked online.
        const pending = up;
        await step('waiting for gh nibfin upgrade --yes to end', async () => {
          await remoteWait(kit, 'gh nibfin upgrade --yes to end', DEADLINE.shape, 10 * SECOND, async () =>
            upEnded === undefined ? undefined : true,
          );
          const r = await pending;
          if (r?.code !== 0)
            throw new Error(`${RULE}: gh nibfin upgrade --yes ${upEnded ?? 'did not end'}${r ? `: ${tail(r)}` : ''}`);
        });
      }
      await step('closing the PRs this scenario opened', async () => {
        for (const p of await openPulls(gh, repo))
          if (!startPulls.includes(p.number))
            await gh.rest('PATCH', `/repos/${repo}/pulls/${p.number}`, { state: 'closed' });
      });
      if (dOld !== undefined) {
        const old = dOld;
        await step(`restoring ${ref(dNew)} on ${repo} main`, async () => {
          const now = await nibfinWorkflows(kit, repo);
          for (const [path, text] of now) {
            const original = originals.get(path);
            if (pins(text).includes(ref(old)) && original !== undefined)
              await putFile(gh, repo, path, original, `nibfin-e2e: restore the current image (${RULE})`);
          }
          const odd = otherPins(await nibfinWorkflows(kit, repo), ref(dNew));
          if (odd.length) throw new Error(`main still pins ${odd.join(', ')}`);
        });
      }
      await step('waiting for every Runner to be online', () =>
        remoteWait(kit, `all ${runners} Runners of ${repo} online`, DEADLINE.runnerOnline, 10 * SECOND, async () => {
          const rs = await registrations(gh, repo);
          return rs.length === runners && rs.every((r) => r.status === 'online') ? true : undefined;
        }),
      );
      if (!down.length) return result;
      return {
        status: 'failed',
        reason: [result.status === 'failed' ? result.reason : undefined, ...down].filter(Boolean).join('; '),
      };
    },
  };
}
