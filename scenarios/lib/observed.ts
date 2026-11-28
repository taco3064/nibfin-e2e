import type { StepOutcome } from '../../src/types.ts';
import { watchJobContainers } from './containers.ts';
import type { Projection, Watch } from './containers.ts';
import {
  DECOY_FILES,
  DECOY_PATTERN,
  EXTEND_TEXT,
  PROBE_FILE,
  RULESYNC_FILES,
  TASK_BODY,
  TOOLS,
  json,
} from './files.ts';
import type { Comment } from './fixture.ts';
import { excerpt, redact, redactDeep } from './checks.ts';
import {
  approvalRuleset,
  close,
  comments,
  deleteE2eRulesets,
  issueState,
  labels,
  openFixture,
  prepareFixture,
} from './fixture.ts';
import { buildOutput, imageLine, initEvents, jobLog } from './joblog.ts';
import type { InitEvent } from './joblog.ts';
import { message } from './kit.ts';
import type { Kit } from './kit.ts';
import { parseProbe } from './probe.ts';
import {
  CLAUDE_VOLUME,
  TOOLS_VOLUME,
  inspectVolume,
  listVolume,
  readLoginFacts,
  removeLoginKey,
  statVolume,
} from './volume.ts';
import type { LoginFacts, VolumeFile, VolumeInfo } from './volume.ts';
import { DEADLINE, remoteWait } from './waits.ts';

/** What the observed-job step saw; scenarios read it through `facts('observed-job')`. */
export interface ObservedFacts {
  repo: string;
  issue?: number;
  /** The Shape container's inspect projection. */
  projection?: Projection;
  /** The image of every fixture Job container the watch inspected, in start order (Proposal R5.9). */
  jobImages?: string[];
  rootless?: boolean;
  /** Local images named ghcr.io/taco3064/nibfin, with their repo digests. */
  localImages?: { names: string[]; repoDigests: string[] }[];
  /** The probe block of the published Shape, as key → values. */
  probe?: Record<string, string[]>;
  shapeLog?: { imageRef?: string; buildOutput?: string; init: InitEvent[]; slot: string };
  loginBefore?: LoginFacts;
  loginAfter?: LoginFacts;
  /** Auto-memory entries (`projects/*\/memory`) in the login volume. */
  memoryEntries?: string[];
  decoys?: { tools: string[]; login: string[] };
  /** Every path of the pushed `nibfin/issue-<n>` tree. */
  branchPaths?: string[];
  pr?: number;
  /** How the PR ended while the approval ruleset was in force. */
  finish?: { merged: boolean; approvalComment?: string };
  /** `podman volume inspect` of the login volume, read before the first Job. */
  loginVolume?: VolumeInfo | ReadError;
  /** Names, sizes and mtimes (never contents) of the login volume's files before Shape, after Shape and after Review. */
  volumeFiles?: {
    beforeJobs: VolumeFile[] | ReadError;
    afterShape?: VolumeFile[] | ReadError;
    afterJobs?: VolumeFile[] | ReadError;
  };
  /** The login settings after the Review Job. */
  loginAfterJobs?: LoginFacts | ReadError;
  /** Every Job container of the fixture in start order (Shape, Deliver, Review, then extra-<k>), with its projection. */
  jobs?: ObservedJob[];
}

/** A read that failed; the message carries the command output. Scenarios needing it fail on it. */
export interface ReadError {
  error: string;
}

export interface ObservedJob {
  stage: string;
  id: string;
  projection?: Projection;
}

/** The result of `read`, or `{ error }` with its message: these reads never fail the step. */
async function attempt<T>(read: () => Promise<T>): Promise<T | ReadError> {
  try {
    return await read();
  } catch (error) {
    return { error: message(error) };
  }
}

const STAGES = ['Shape', 'Deliver', 'Review'];

/** Every container started so far, in start order, named by stage. */
export async function observedJobs(watch: Watch): Promise<ObservedJob[]> {
  const ids = [...new Set(watch.events.filter((e) => e.kind === 'start').map((e) => e.id))];
  return Promise.all(
    ids.map(async (id, i) => {
      const projection = await watch.projection(id);
      return { stage: STAGES[i] ?? `extra-${i - STAGES.length + 1}`, id, ...(projection ? { projection } : {}) };
    }),
  );
}

const pathsOf = async (kit: Kit, repo: string, ref: string) => {
  const { data } = await kit.github.rest<{ tree: { path: string }[]; truncated?: boolean }>(
    'GET',
    `/repos/${repo}/git/trees/${ref.split('/').map(encodeURIComponent).join('/')}?recursive=1`,
  );
  return data.tree.map((t) => t.path).sort();
};

/** A local image named ghcr.io/taco3064/nibfin: its image id, names and repo digests. */
export interface LocalImage {
  id: string;
  names: string[];
  repoDigests: string[];
}

/** The local images named ghcr.io/taco3064/nibfin (`podman images`). */
export async function imagesNamed(kit: Pick<Kit, 'exec'>): Promise<LocalImage[]> {
  const r = await kit.exec(['podman', 'images', '--format', 'json', '--filter', 'reference=ghcr.io/taco3064/nibfin']);
  if (r.code !== 0) throw new Error(`podman images exited ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  const list = JSON.parse(r.stdout || '[]') as { Id?: string; Names?: string[]; RepoDigests?: string[] }[];
  return list.map((i) => ({ id: i.Id ?? '', names: i.Names ?? [], repoDigests: i.RepoDigests ?? [] }));
}

async function rootless(kit: Kit): Promise<boolean | undefined> {
  const r = await kit.exec(['podman', 'info', '--format', 'json']);
  if (r.code !== 0) return undefined;
  return (JSON.parse(r.stdout) as { host?: { security?: { rootless?: boolean } } }).host?.security?.rootless;
}

/** Fails when the Issue went `pending` (no further stage will come), naming its state. */
async function notPending(kit: Kit, repo: string, n: number, stage: string): Promise<void> {
  if ((await labels(kit, repo, n)).includes('pending'))
    throw new Error(`the ${stage} stage ended with pending: ${await issueState(kit, repo, n)}`);
}

/** Waits for the nth `died`; a deadline failure names the stage and the Issue's state. */
async function stageDied(
  kit: Kit,
  watch: Watch,
  repo: string,
  n: number,
  count: number,
  stage: string,
  ms: number,
): Promise<void> {
  try {
    await watch.died(count, ms, `the ${stage} Job container of ${repo}#${n} to end`);
  } catch (error) {
    throw new Error(`${message(error)}; ${await issueState(kit, repo, n)}`, { cause: error });
  }
}

/**
 * The line of a Nibfin PR comment saying the merge waits for an approving review
 * (Proposal R3.26). Nibfin writes with the Owner's credential, so its comments are the
 * Owner's; the harness never comments on a PR. The line must be about the merge and an
 * approving review (or approval) still missing; a Shape review comment mentioning the
 * "approved Shape" does not count. `secrets` are removed before the line is cut.
 */
export function missingApprovalLine(list: Comment[], owner: string, secrets: string[] = []): string | undefined {
  const lines = list.filter((c) => c.user?.login === owner).flatMap((c) => c.body.split('\n'));
  const line = lines.find(
    (l) => /approving review|approvals?\b/i.test(l) && /merg/i.test(l) && /wait|missing|requir|need|block/i.test(l),
  );
  return line === undefined ? undefined : excerpt(line.trim(), 300, secrets);
}

/** The image of each started Job container, in start order; one gone before inspection shows as `(not inspected)`. */
export function jobImagesOf(watch: Pick<Watch, 'events' | 'projections'>): string[] {
  return watch.events
    .filter((e) => e.kind === 'start')
    .map((e) => watch.projections.get(e.id)?.imageName ?? '(not inspected)');
}

/** Runs one fixture through Shape → Deliver → Review and records what its Jobs ran with (Issue #299). */
export async function runObservedJob(kit: Kit): Promise<StepOutcome> {
  const repo = kit.sandbox.execution;
  const facts: ObservedFacts = { repo };
  // Facts hold agent-written text (the probe block, branch paths, log lines), which GitHub
  // does not mask; every string is redacted before it leaves the step (Proposal R3.49).
  let watch: Watch | undefined;
  const out = () => {
    if (watch) facts.jobImages = jobImagesOf(watch);
    return redactDeep(facts, kit.secrets()) as unknown as Record<string, unknown>;
  };
  try {
    await prepareFixture(kit, repo, {
      files: [
        {
          path: '.nibfin.json',
          content: json({
            tools: TOOLS,
            skills: { shape: { mode: 'extend', path: '.nibfin/skills/shape-extend.md' } },
          }),
        },
        { path: '.nibfin/skills/shape-extend.md', content: EXTEND_TEXT },
        PROBE_FILE,
        ...RULESYNC_FILES,
        ...DECOY_FILES,
      ],
      variables: { NIBFIN_MODEL: 'haiku' },
      ruleset: approvalRuleset(),
    });
    facts.loginBefore = await removeLoginKey(kit.exec, 'enableAllProjectMcpServers');
    facts.loginVolume = await attempt(() => inspectVolume(kit.exec, CLAUDE_VOLUME));
    facts.volumeFiles = { beforeJobs: await attempt(() => statVolume(kit.exec, CLAUDE_VOLUME)) };

    const n = await openFixture(kit, repo, 'e2e observed job: add double(n)', TASK_BODY);
    facts.issue = n;
    watch = watchJobContainers(kit, repo, n, async (_e, index) => {
      if (index !== 0) return;
      facts.rootless = await rootless(kit);
      facts.localImages = await imagesNamed(kit);
    });

    // Shape.
    const shapeStart = await watch.started(1, DEADLINE.shape, `the Shape Job container of ${repo}#${n} to start`);
    facts.projection = await watch.projection(shapeStart.id);
    await stageDied(kit, watch, repo, n, 1, 'Shape', DEADLINE.shape);
    const all = (await comments(kit, repo, n)).map((c) => c.body).join('\n');
    const probe = parseProbe(all);
    facts.probe = probe ? Object.fromEntries(probe) : undefined;
    const p = facts.projection;
    if (p?.runId) {
      const { job, text } = await jobLog(kit, p.runRepo ?? repo, p.runId, `observed-job-${n}-shape`);
      facts.shapeLog = {
        imageRef: imageLine(text),
        buildOutput: buildOutput(text),
        init: initEvents(text),
        slot: job.slot,
      };
    }
    facts.loginAfter = await readLoginFacts(kit.exec);
    facts.volumeFiles.afterShape = await attempt(() => statVolume(kit.exec, CLAUDE_VOLUME));
    facts.memoryEntries = await listVolume(kit.exec, CLAUDE_VOLUME, '.', 'memory');
    facts.decoys = {
      tools: await listVolume(kit.exec, TOOLS_VOLUME, '.', DECOY_PATTERN),
      login: await listVolume(kit.exec, CLAUDE_VOLUME, '.', DECOY_PATTERN),
    };
    await notPending(kit, repo, n, 'Shape');

    // Deliver.
    await stageDied(kit, watch, repo, n, 2, 'Deliver', DEADLINE.deliver);
    await notPending(kit, repo, n, 'Deliver');
    const branch = `nibfin/issue-${n}`;
    facts.branchPaths = await pathsOf(kit, repo, branch);
    const owner = repo.split('/')[0] as string;
    const pulls = await kit.github.list<{ number: number }>(
      `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    facts.pr = pulls[0]?.number;
    if (facts.pr === undefined)
      throw new Error(`no pull request from ${branch} after Deliver; ${await issueState(kit, repo, n)}`);

    // Review, then the finish Job on a GitHub-hosted runner (no local event marks its end).
    await stageDied(kit, watch, repo, n, 3, 'Review', DEADLINE.review);
    facts.volumeFiles.afterJobs = await attempt(() => statVolume(kit.exec, CLAUDE_VOLUME));
    facts.loginAfterJobs = await attempt(() => readLoginFacts(kit.exec));
    facts.jobs = await observedJobs(watch);
    const pr = facts.pr;
    facts.finish = await remoteWait(
      kit,
      `PR #${pr} to merge or get Nibfin's comment about the missing approving review`,
      DEADLINE.finish,
      30_000,
      async () => {
        const { data } = await kit.github.rest<{ merged?: boolean }>('GET', `/repos/${repo}/pulls/${pr}`);
        if (data.merged) return { merged: true };
        const line = missingApprovalLine(await comments(kit, repo, pr), owner, kit.secrets());
        return line ? { merged: false, approvalComment: line } : undefined;
      },
    );
    return {
      status: 'passed',
      reason: redact(
        `fixture ${repo}#${n} ran Shape, Deliver and Review; PR #${pr} ${facts.finish.merged ? 'merged' : 'waits for an approving review'}`,
        kit.secrets(),
      ),
      facts: out(),
    };
  } catch (error) {
    // Every failure after the Issue exists names its labels and latest comment.
    const state =
      facts.issue !== undefined && !message(error).includes(`#${facts.issue} labels`)
        ? `; ${await issueState(kit, repo, facts.issue)}`
        : '';
    return { status: 'failed', reason: redact(message(error) + state, kit.secrets()), facts: out() };
  } finally {
    watch?.stop();
    if (facts.issue !== undefined) await close(kit, repo, facts.issue).catch(() => {});
    await deleteE2eRulesets(kit, repo).catch(() => {});
  }
}
