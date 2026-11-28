import { randomBytes } from 'node:crypto';
import type { RunContext } from '../../src/types.ts';
import { classifyJob, replaceDigest, rogueWorkflow, tamperTemplate, unsignedDigest } from './parse.ts';
import type { Classified, Job } from './parse.ts';
import { hasLabel, jobLog, jobs, message, realClock, registrations, runs, until } from './observe.ts';
import type { Clock } from './observe.ts';

export const HOOK_TARGET_TITLE = '[e2e collaborator] hook target';
const SHARED = '.github/workflows/nibfin-shared-runner.yml';
const JOB = '.github/workflows/nibfin-job.yml';
const ROGUE = '.github/workflows/e2e-rogue.yml';

export type ProbeCase = 'main' | 'control' | 'template' | 'digest' | 'rogue';

export interface ProbeResult {
  case: ProbeCase;
  /** The ref the Job's workflow came from and the commit GitHub ran. */
  ref: string;
  headSha?: string;
  runId?: number;
  job?: Job;
  classified: Classified;
}

const path = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/**
 * Starts Jobs aimed at the collaborator's Runners and classifies how the job-started
 * hook answered each (Proposal R6.7). Every probe ends with a finished Job or a reason.
 */
export function createProber(ctx: RunContext, clock: Clock = realClock) {
  const gh = ctx.github;
  const repo = ctx.sandbox.execution;
  const r = `/repos/${repo}`;
  const peer = ctx.peer();
  const label = `nibfin-${peer.id}`;
  const started = new Set<number>();
  let target: Promise<number> | undefined;

  const targetIssue = () =>
    (target ??= gh
      .rest<{ number: number }>('POST', `${r}/issues`, {
        title: HOOK_TARGET_TITLE,
        body: 'nibfin-e2e Issue #300: a target for job-started hook probes. It has no label and no Assignee, so a Nibfin stage has nothing to do on it.',
      })
      .then((x) => x.data.number));

  async function main(): Promise<{ sha: string; tree: string }> {
    const { data } = await gh.rest<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(
      'GET',
      `${r}/branches/main`,
    );
    return { sha: data.commit.sha, tree: data.commit.commit.tree.sha };
  }

  async function readMain(file: string): Promise<string> {
    const { data } = await gh.rest<{ content: string }>('GET', `${r}/contents/${path(file)}?ref=main`);
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  /** A branch off main with at most the given files changed (Git Data API). */
  async function branchFrom(name: string, files: { path: string; content: string }[]): Promise<string> {
    const base = await main();
    let tree = base.tree;
    if (files.length) {
      const entries = files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content }));
      tree = (await gh.rest<{ sha: string }>('POST', `${r}/git/trees`, { base_tree: base.tree, tree: entries })).data
        .sha;
    }
    const { data: commit } = await gh.rest<{ sha: string }>('POST', `${r}/git/commits`, {
      message: `nibfin-e2e hook probe ${name}`,
      tree,
      parents: [base.sha],
    });
    await gh.rest('POST', `${r}/git/refs`, { ref: `refs/heads/${name}`, sha: commit.sha });
    return commit.sha;
  }

  async function findRun(query: string, workflowPath: string, known: Set<number>, since: number): Promise<number> {
    return until(
      `a ${workflowPath} run for ${query}`,
      async () => {
        const found = (await runs(gh, repo, query, since)).filter(
          (x) => x.path.startsWith(workflowPath) && !known.has(x.id) && Date.parse(x.created_at) >= since - 60_000,
        );
        const run = found.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
        return { value: run?.id, state: `${found.length} new runs` };
      },
      5 * 60_000,
      clock,
    );
  }

  async function dispatch(ref: string): Promise<number> {
    const issue = await targetIssue();
    const query = `event=workflow_dispatch&branch=${encodeURIComponent(ref)}`;
    const since = clock.now();
    const known = new Set((await runs(gh, repo, query, since)).map((x) => x.id));
    const res = await gh.rest<{ workflow_run_id?: number } | undefined>(
      'POST',
      `${r}/actions/workflows/nibfin-shared-runner.yml/dispatches`,
      {
        ref,
        inputs: { repo, issue: String(issue), stage: 'shape', assignee: String(peer.id) },
      },
    );
    const id = res.data?.workflow_run_id;
    return typeof id === 'number' ? id : findRun(query, SHARED, known, since);
  }

  /** Waits for the run's Job on the collaborator's label to finish, then classifies it. */
  async function settle(c: ProbeCase, ref: string, runId: number, markers: string[]): Promise<ProbeResult> {
    started.add(runId);
    const job = await until(
      `run ${runId}: a finished Job on ${label}`,
      async () => {
        const all = await jobs(gh, repo, runId);
        const mine = all.find((j) => j.labels.includes(label));
        const state =
          all.map((j) => `${j.id} [${j.labels.join(',')}] ${j.status}/${String(j.conclusion)}`).join('; ') ||
          'no jobs yet';
        return { value: mine?.status === 'completed' ? mine : undefined, state };
      },
      25 * 60_000,
      clock,
    );
    const peerRunners = (await registrations(gh, repo)).filter((x) => hasLabel(x, label)).map((x) => x.name);
    const log = await jobLog(gh, repo, job.id);
    return { case: c, ref, runId, headSha: job.head_sha, job, classified: classifyJob(job, log, peerRunners, markers) };
  }

  async function probe(c: ProbeCase): Promise<ProbeResult> {
    const nonce = randomBytes(6).toString('hex');
    const ref = c === 'main' ? 'main' : `e2e-hook-${c}-${nonce}`;
    try {
      if (c === 'rogue') {
        const since = clock.now();
        const query = `event=push&branch=${encodeURIComponent(ref)}`;
        await branchFrom(ref, [{ path: ROGUE, content: rogueWorkflow(ref, peer.id, nonce) }]);
        let runId: number;
        try {
          runId = await findRun(query, ROGUE, new Set(), since);
        } catch (error) {
          throw new Error(
            `rogue run did not start (creating the branch through the API may not run its on: push workflow): ${message(error)}`,
            { cause: error },
          );
        }
        return await settle(c, ref, runId, ['Nibfin image:', `e2e-rogue-step-${nonce}`]);
      }
      if (c === 'template')
        await branchFrom(ref, [{ path: SHARED, content: tamperTemplate(await readMain(SHARED), nonce) }]);
      if (c === 'digest')
        await branchFrom(ref, [{ path: JOB, content: replaceDigest(await readMain(JOB), unsignedDigest(nonce)) }]);
      if (c === 'control') await branchFrom(ref, []);
      return await settle(c, ref, await dispatch(ref), ['Nibfin image:']);
    } catch (error) {
      return { case: c, ref, classified: { kind: 'invalid', why: message(error) } };
    }
  }

  /** Cancels every probe run that is still active. */
  async function cancelActive(): Promise<void> {
    for (const id of started) {
      const { data } = await gh.rest<{ status: string }>('GET', `${r}/actions/runs/${id}`, undefined, [404]);
      if (data?.status && data.status !== 'completed')
        await gh.rest('POST', `${r}/actions/runs/${id}/cancel`, undefined, [409]);
    }
  }

  return { probe, cancelActive, main };
}
