import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_DIGEST, KNOWN_VISIBILITY, SANDBOX } from './host/config.ts';
import { mustRun } from './host/exec.ts';
import type { ExecResult } from './host/exec.ts';
import { installGhNibfin } from './host/ghnibfin.ts';
import { baselineOf, hasUserManager, hostPeriodicRun, readHostState, readPeriodic, readVmPeriodic, seedWslconfig, userRuntimeDir } from './host/hoststate.ts';
import type { HostRun, HostState } from './host/hoststate.ts';
import type { GitHub } from './host/github.ts';
import { writeClaudeLogin } from './host/login.ts';
import { preparePeer, teardownPeer } from './host/peer.ts';
import type { PeerFacts } from './host/peer.ts';
import { preparePodman } from './host/podman.ts';
import { mainHead, onlineRunners, readTemplate, resetSandbox } from './host/sandbox.ts';
import type { HostServices } from './host/services.ts';
import type { ProvisioningStep, RunContext, StepOutcome } from './types.ts';
import { createKit } from '../scenarios/lib/kit.ts';
import { runObservedJob } from '../scenarios/lib/observed.ts';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tail = (r: ExecResult) => (r.stderr.trim() || r.stdout.trim()).slice(-4000);

/** Resets both sandboxes and reads them back; throws listing what is left. */
async function resetBoth(host: HostServices, ctx: RunContext): Promise<string> {
  const deps = { github: host.github, template: readTemplate(join(host.repoRoot, 'sandbox-template')), log: ctx.log };
  const left = [
    ...(await resetSandbox(deps, SANDBOX.execution, KNOWN_VISIBILITY.execution)),
    ...(await resetSandbox(deps, SANDBOX.peer, KNOWN_VISIBILITY.peer)),
  ];
  if (left.length) throw new Error(`sandbox read-back is not clean: ${left.join('; ')}`);
  return `${SANDBOX.execution} (public) and ${SANDBOX.peer} (private) reset and read back clean`;
}

/** Whether `status --json` lists a local claude Runner; undefined when the output cannot tell. */
export function claudeRunnersLeft(stdout: string): boolean | undefined {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const runners = (v as { host?: { runners?: { runners?: unknown } } } | null)?.host?.runners?.runners;
  if (runners === null) return false;
  if (!Array.isArray(runners)) return undefined;
  return runners.some((r) => (r as { provider?: unknown } | null)?.provider === 'claude');
}

export interface InitPr {
  number: number;
  headSha: string;
  workflows: string[];
  digests: string[];
}

/** The single open pull request `init` opened, its workflow files and the image digests they pin. */
export async function readInitPr(gh: GitHub, repo: string): Promise<InitPr> {
  const r = `/repos/${repo}`;
  const pulls = await gh.list<{ number: number; head: { sha: string } }>(`${r}/pulls?state=open`);
  const [pr] = pulls;
  if (pulls.length !== 1 || !pr) throw new Error(`${repo}: expected exactly one open pull request after init, found ${pulls.length}`);
  const files = await gh.list<{ filename: string; status: string }>(`${r}/pulls/${pr.number}/files`);
  const workflows = files.filter((f) => f.status !== 'removed' && f.filename.startsWith('.github/workflows/')).map((f) => f.filename);
  const digests = new Set<string>();
  for (const path of workflows) {
    const { data } = await gh.rest<{ content: string }>('GET', `${r}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${pr.head.sha}`);
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    for (const m of text.matchAll(IMAGE_DIGEST)) digests.add(m[1] as string);
  }
  return { number: pr.number, headSha: pr.head.sha, workflows, digests: [...digests].sort() };
}

/** Rebase-merges the init PR as the Owner would (Proposal R5.54) and reads back its workflows on main. */
async function mergeInitPr(gh: GitHub, repo: string, pr: InitPr): Promise<void> {
  const r = `/repos/${repo}`;
  await gh.rest('PUT', `${r}/pulls/${pr.number}/merge`, { merge_method: 'rebase', sha: pr.headSha });
  for (const path of pr.workflows) {
    const got = await gh.rest('GET', `${r}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=main`, undefined, [404]);
    if (got.status === 404) throw new Error(`${repo}: ${path} is not on main after merging #${pr.number}`);
  }
}

/** main's head commit and tree right after the init PR merged. */
async function baseline(gh: GitHub, repo: string): Promise<{ commit: string; tree: string }> {
  const head = await mainHead(gh, repo);
  if (!head) throw new Error(`${repo}: branch main does not exist after merging the init PR`);
  return head;
}

/**
 * Adds the periodic baseline (Proposal R5.17) to the host state before runner add. A failed
 * read is kept as `{ error }`, so only the scenario that needs it fails. On Windows the
 * podman machine is started to read inside the VM and stopped again, so that runner add
 * still finds it stopped; a failed stop throws.
 */
export async function readPeriodicBaseline(run: HostRun, host: Pick<HostServices, 'env' | 'exec'>, before: HostState): Promise<void> {
  if (before.platform === 'linux') {
    const runtime = userRuntimeDir(host.env);
    before.periodic = await baselineOf(() => readPeriodic(hostPeriodicRun(run, runtime), { noManagerOk: !hasUserManager(runtime, existsSync) }));
    return;
  }
  const start = await host.exec(['podman', 'machine', 'start']);
  if (start.code !== 0) {
    before.vm = { error: `podman machine start exited ${start.code}: ${tail(start) || 'no output'}` };
    return;
  }
  before.vm = await baselineOf(() => readVmPeriodic(run));
  const stop = await host.exec(['podman', 'machine', 'stop']);
  if (stop.code !== 0) throw new Error(`podman machine stop after reading the VM baseline exited ${stop.code}: ${tail(stop)}`);
}

/** Host provisioning, in the order the steps run (Issue #283). */
export function createProvisioning(host: HostServices): ProvisioningStep[] {
  return [
    {
      id: 'gh-nibfin',
      run: async (ctx) => ({ status: 'passed', reason: await installGhNibfin(host, ctx.target.ghNibfinCommit, ctx.target.platform) }),
    },
    {
      id: 'podman',
      run: async (ctx) => ({ status: 'passed', reason: await preparePodman(host, ctx.target.platform) }),
    },
    {
      id: 'claude-login',
      requires: ['podman'],
      run: async (ctx) => ({ status: 'passed', reason: await writeClaudeLogin(host, ctx.target.platform) }),
    },
    {
      id: 'sandboxes',
      async run(ctx): Promise<StepOutcome> {
        const online = await onlineRunners(host.github, SANDBOX.execution);
        if (online.length) {
          return {
            status: 'failed',
            reason:
              `another host appears to be using the sandboxes: runner registrations ${online.join(', ')} are online on ${SANDBOX.execution}; ` +
              'nothing was reset. Only one host may use the sandboxes at a time, so matrix legs must run one after another',
            facts: { guard: 'refused' },
          };
        }
        try {
          return { status: 'passed', reason: await resetBoth(host, ctx), facts: { guard: 'passed' } };
        } catch (error) {
          return { status: 'failed', reason: message(error), facts: { guard: 'passed' } };
        }
      },
      async teardown(ctx) {
        if (ctx.facts('sandboxes')?.guard !== 'passed') return { status: 'passed', reason: 'this host did not reset the sandboxes; nothing to clean' };
        return { status: 'passed', reason: await resetBoth(host, ctx) };
      },
    },
    {
      id: 'nibfin',
      requires: ['gh-nibfin', 'podman', 'claude-login', 'sandboxes'],
      async run(ctx): Promise<StepOutcome> {
        const commands: { args: string[]; code: number; stdout: string; stderr: string }[] = [];
        const facts: Record<string, unknown> = { commands };
        const nibfin = async (args: string[]) => {
          const r = await ctx.ghNibfin(args);
          commands.push({ args, ...r });
          if (r.code !== 0) throw new Error(`gh nibfin ${args.join(' ')} exited ${r.code}: ${tail(r)}`);
        };
        try {
          await mustRun(host.exec, ['git', 'clone', '--quiet', `https://github.com/${SANDBOX.execution}.git`, ctx.executionDir]);
          // The host state before runner add, so scenarios can see what the always-on setup changed.
          if (ctx.target.platform === 'windows') seedWslconfig();
          const run: HostRun = (argv, env) => host.exec(argv, { env });
          const before = await readHostState(run, ctx.target.platform, { env: host.env });
          await readPeriodicBaseline(run, host, before);
          facts.hostBefore = before;
          facts.runnerAdd = true;
          await nibfin(['runner', 'add', 'claude', '--count', '2', '--yes']);
          await nibfin(['init', '--yes']);
          await nibfin(['init', '-R', SANDBOX.peer, '--yes']);
          const execution = await readInitPr(host.github, SANDBOX.execution);
          const peer = await readInitPr(host.github, SANDBOX.peer);
          facts.executionPr = execution.number;
          facts.peerPr = peer.number;
          const [digest] = execution.digests;
          if (execution.digests.length !== 1 || digest === undefined) {
            throw new Error(
              `${SANDBOX.execution}: init PR #${execution.number} pins ${execution.digests.length ? `conflicting image digests ${execution.digests.join(', ')}` : 'no ghcr.io/taco3064/nibfin@sha256 image'}`,
            );
          }
          facts.imageDigest = digest;
          await mergeInitPr(host.github, SANDBOX.execution, execution);
          await mergeInitPr(host.github, SANDBOX.peer, peer);
          // Nothing else writes main between the merges and this read: no Issue exists yet.
          // Fixtures start from these trees (scenarios/lib/fixture.ts).
          facts.executionBaseline = await baseline(host.github, SANDBOX.execution);
          facts.peerBaseline = await baseline(host.github, SANDBOX.peer);
          return { status: 'passed', reason: `Runners added; init PRs #${execution.number} and #${peer.number} merged; image ${digest}`, facts };
        } catch (error) {
          return { status: 'failed', reason: message(error), facts };
        }
      },
      async teardown(ctx) {
        if (ctx.facts('nibfin')?.runnerAdd !== true) return { status: 'passed', reason: 'runner add did not run; nothing to remove' };
        // A scenario may already have removed every Runner (runner-remove); then runner remove has nothing to do.
        const status = await ctx.ghNibfin(['status', '--json']);
        if (status.code === 0 && claudeRunnersLeft(status.stdout) === false) return { status: 'passed', reason: 'no local Runners left' };
        const r = await ctx.ghNibfin(['runner', 'remove', 'claude', '--yes']);
        if (r.code !== 0) return { status: 'failed', reason: `gh nibfin runner remove claude --yes exited ${r.code}: ${tail(r)}` };
        return { status: 'passed', reason: 'local Runners removed' };
      },
    },
    {
      // One agent fixture through Shape → Deliver → Review, observed once per run for
      // several scenarios (Issue #299). The sandbox reset removes what it leaves.
      id: 'observed-job',
      requires: ['nibfin'],
      run: (ctx) => runObservedJob(createKit(host, ctx)),
    },
    {
      // The collaborator's side (Issue #300): its teardown runs before nibfin's and the sandbox reset.
      id: 'collaborator',
      requires: ['gh-nibfin', 'podman', 'nibfin'],
      async run(ctx): Promise<StepOutcome> {
        const facts: PeerFacts = {};
        try {
          const reason = await preparePeer(host, ctx.target.platform, facts);
          return { status: 'passed', reason, facts: { ...facts } };
        } catch (error) {
          return { status: 'failed', reason: message(error), facts: { ...facts } };
        }
      },
      async teardown(ctx) {
        const problems = await teardownPeer(host, ctx.facts('collaborator') as PeerFacts | undefined);
        if (problems.length) return { status: 'failed', reason: problems.join('; ') };
        return { status: 'passed', reason: "the collaborator's local Runners and this run's SSH key are removed" };
      },
    },
  ];
}
