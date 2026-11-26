import type { ExecOptions, ExecResult } from '../../src/host/exec.ts';
import { createGitHub } from '../../src/host/github.ts';
import type { RunContext } from '../../src/types.ts';
import { fakeHostContext } from '../host/fakes.ts';
import { setup } from './kit.ts';

export const DIGEST = 'sha256:' + 'd'.repeat(64);
export const IMAGE = `ghcr.io/taco3064/nibfin@${DIGEST}`;

/** What simulated Nibfin does with one fixture Issue's first Job. */
export interface JobPlan {
  runner?: string;
  log?: string;
  comments?: string[];
  labels?: string[];
  memory?: number;
  /** Runs after the container started and before it died (for example an agent pushing to main). */
  during?: () => void;
}

const tick = () => new Promise((r) => setImmediate(r));
export async function until(cond: () => boolean, what = 'the expected point') {
  for (let i = 0; i < 5000 && !cond(); i++) await tick();
  if (!cond()) throw new Error(`the simulation did not reach ${what}`);
}

/**
 * The fake host and GitHub with a simulated Nibfin: every fixture Issue opened gets one
 * Job container (start, then died) whose run, log, labels and comments `plan` returns.
 */
export function simulate(plan: (repo: string, issue: number) => JobPlan, extra: { respond?: (argv: string[], o: ExecOptions) => Partial<ExecResult> | undefined } = {}) {
  const runs = new Map<string, { repo: string; plan: JobPlan }>();
  let next = 0;
  const h = setup({
    respond: (argv, o) => {
      if (argv[1] === 'container' && argv[2] === 'inspect') {
        const run = runs.get(argv[3] ?? '');
        if (!run) return { code: 125, stderr: 'no such container' };
        return { stdout: JSON.stringify([{ ImageName: IMAGE, HostConfig: { Memory: run.plan.memory ?? 3e9, NanoCpus: run.plan.memory === 0 ? 0 : 2e9, PidsLimit: 2048 }, Config: { Env: [`NIBFIN_RUN_ID=${argv[3]}`, `NIBFIN_RUN_REPO=o/exec`] } }]) };
      }
      return extra.respond?.(argv, o);
    },
  });
  const original = h.fake.fetch;
  const started: Promise<void>[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    let m = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (m) {
      const run = runs.get(m[1] as string);
      return new Response(JSON.stringify({ total_count: 2, jobs: [{ id: 1, name: 'route', runner_name: 'GitHub Actions 1', status: 'completed' }, { id: Number(m[1]), name: 'stage', runner_name: run?.plan.runner ?? 'myhost-1a2b3c4d-claude-1', status: 'completed' }] }));
    }
    m = /\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
    if (m) return new Response(runs.get(m[1] as string)?.plan.log ?? '');
    const res = await original(input, init);
    const created = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
    if (created && init?.method === 'POST' && res.status === 201) {
      const repo = created[1] as string;
      const { number } = (await res.clone().json()) as { number: number };
      started.push(runJob(repo, number));
    }
    return res;
  };
  async function runJob(repo: string, number: number) {
    await until(() => h.events.watching(repo, number).length > 0, `a watch on ${repo}#${number}`);
    const p = plan(repo, number);
    const id = String(100 + ++next);
    runs.set(id, { repo, plan: p });
    h.events.emitFor(repo, number, JSON.stringify({ ID: id, Status: 'start' }));
    await tick();
    p.during?.();
    const issue = h.repo(repo).issues.find((i) => i.number === number);
    if (issue) {
      issue.labels = [...new Set([...(issue.labels ?? []), ...(p.labels ?? [])])];
      issue.comments = [...(issue.comments ?? []), ...(p.comments ?? [])];
    }
    h.events.emitFor(repo, number, JSON.stringify({ ID: id, Status: 'died' }));
  }
  h.kit.github = createGitHub(() => 'tok', fetchFn);
  h.kit.fetch = fetchFn;
  return { ...h, runs };
}

export function ctxFor(facts: Record<string, Record<string, unknown>> = {}): RunContext {
  return {
    ...fakeHostContext,
    target: { ghNibfinCommit: 'a'.repeat(40), platform: 'linux' },
    log: () => {},
    defer: () => {},
    facts: (id) => facts[id] ?? (id === 'nibfin' ? { imageDigest: DIGEST } : undefined),
  };
}
