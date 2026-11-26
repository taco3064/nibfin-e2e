import { join } from 'node:path';
import type { ExecResult } from '../../src/host/exec.ts';
import type { PeerStat } from '../../src/host/peer.ts';
import type { RunContext } from '../../src/types.ts';
import { createProber } from './hook.ts';
import type { ProbeResult } from './hook.ts';
import { parseRegistrationComment } from './parse.ts';
import type { Job, RegistrationComment } from './parse.ts';
import { comments, deployKeys, hasLabel, jobs, message, realClock, registrations, requestIssues, runs, until } from './observe.ts';
import type { Clock, Comment, DeployKey, Issue, Registration, Run } from './observe.ts';

/** One collaborator `runner add` and what GitHub and the host show around it. */
export interface Registered {
  permission: string;
  startedAt: number;
  exitedAt: number;
  command: ExecResult;
  before: Registration[];
  /** Request Issues the collaborator opened since the command started, read after it exited. */
  issues: Issue[];
  comments: Comment[];
  answer?: { comment: Comment; parsed: RegistrationComment };
  run?: Run;
  job?: Job;
  /** Every registration after the command, and the collaborator's new ones. */
  after: Registration[];
  added: Registration[];
  /** The added registrations reached online (null when none appeared). */
  online: string | null;
  deployKeys: DeployKey[];
  /** The dedicated deploy key directory of this execution repository on the collaborator's host. */
  deployKeyDir: string;
}

export interface LocalState {
  units: string[];
  runnerDirs: string[];
  hook: PeerStat | undefined;
}

export interface Removed {
  reg: Registered;
  command: ExecResult;
  before: { runners: Registration[]; keys: DeployKey[] };
  after: { runners: Registration[]; keys: DeployKey[] };
  local: LocalState;
  /** Problems deleting the collaborator's stale registrations as the Owner would (setup only). */
  cleanup: string[];
}

export interface PrivateResult {
  reg: Registered;
  visibility: string;
  mainSha: string;
  probe: ProbeResult;
  remove: ExecResult;
  afterRemove: { runners: Registration[]; keys: DeployKey[] };
  local: LocalState;
}

interface Memo {
  registration?: Promise<Registered>;
  removal?: Promise<Removed>;
  private?: Promise<PrivateResult>;
}

const memos = new WeakMap<object, Memo>();
const memo = (ctx: RunContext) => {
  let m = memos.get(ctx);
  if (!m) memos.set(ctx, (m = {}));
  return m;
};

export async function localState(ctx: RunContext): Promise<LocalState> {
  const peer = ctx.peer();
  const nibfin = join(peer.dataHome, 'nibfin');
  return {
    units: (await peer.units()).filter((u) => u.startsWith('nibfin-runner-claude-')),
    runnerDirs: (await peer.list(join(nibfin, 'runners'))).filter((d) => d.startsWith('claude-')),
    hook: await peer.stat(join(nibfin, 'hook')),
  };
}

/** `runner add claude --count 1` from the collaborator's clone, with what it left on GitHub. */
export async function register(ctx: RunContext, clock: Clock = realClock): Promise<Registered> {
  const peer = ctx.peer();
  const gh = ctx.github;
  const repo = ctx.sandbox.execution;
  const label = `nibfin-${peer.id}`;
  const perm = await gh.rest<{ permission?: string }>('GET', `/repos/${repo}/collaborators/${encodeURIComponent(peer.login)}/permission`);
  const before = await registrations(gh, repo);
  const startedAt = clock.now();
  const command = await peer.ghNibfin(['runner', 'add', 'claude', '--count', '1', '--yes']);
  const exitedAt = clock.now();
  ctx.log(`collaborator runner add exited ${command.code}`);

  const issues = await requestIssues(gh, repo, peer.login, startedAt);
  const issue = issues[0];
  const all = issue ? await comments(gh, repo, issue.number) : [];
  let answer: Registered['answer'];
  for (const c of all) {
    const parsed = c.user.login === 'github-actions[bot]' ? parseRegistrationComment(c.body) : undefined;
    if (parsed) answer = { comment: c, parsed };
  }

  let run: Run | undefined;
  let job: Job | undefined;
  if (issue) {
    const opened = Date.parse(issue.created_at);
    try {
      run = await until(
        `a completed nibfin-runner-request.yml run for Issue #${issue.number}`,
        async () => {
          const list = (await runs(gh, repo, 'event=issues', opened))
            .filter((x) => x.path.startsWith('.github/workflows/nibfin-runner-request.yml'))
            .filter((x) => Date.parse(x.created_at) >= opened - 5_000 && Date.parse(x.created_at) <= opened + 5 * 60_000)
            .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
          const first = list[0];
          return { value: first?.status === 'completed' ? first : undefined, state: first ? `run ${first.id} ${first.status}` : 'no run' };
        },
        5 * 60_000,
        clock,
      );
      job = (await jobs(gh, repo, run.id))[0];
    } catch (error) {
      ctx.log(message(error));
    }
  }

  const known = new Set(before.map((x) => x.id));
  let after = await registrations(gh, repo);
  let added = after.filter((x) => !known.has(x.id) && hasLabel(x, label));
  let online: string | null = null;
  if (added.length) {
    try {
      online = await until(
        `the collaborator's registrations online`,
        async () => {
          after = await registrations(gh, repo);
          added = after.filter((x) => !known.has(x.id) && hasLabel(x, label));
          const state = added.map((x) => `${x.name} ${x.status}`).join(', ');
          return { value: added.every((x) => x.status === 'online') ? state : undefined, state };
        },
        3 * 60_000,
        clock,
        10_000,
      );
    } catch (error) {
      ctx.log(message(error));
    }
  }
  const [owner, name] = repo.split('/') as [string, string];
  return {
    permission: String(perm.data.permission),
    startedAt,
    exitedAt,
    command,
    before,
    issues,
    comments: all,
    answer,
    run,
    job,
    after,
    added,
    online,
    deployKeys: await deployKeys(gh, repo),
    deployKeyDir: join(peer.dataHome, 'nibfin', 'deploy-keys', 'github.com', owner, name),
  };
}

/** The public registration, once per run. */
export const publicRegistration = (ctx: RunContext) => (memo(ctx).registration ??= register(ctx));

/** The collaborator's `runner remove` after the public registration, once per run. */
export function publicRemoval(ctx: RunContext): Promise<Removed> {
  const m = memo(ctx);
  return (m.removal ??= (async () => {
    const reg = await publicRegistration(ctx);
    const peer = ctx.peer();
    const gh = ctx.github;
    const repo = ctx.sandbox.execution;
    const snapshot = async () => ({ runners: await registrations(gh, repo), keys: await deployKeys(gh, repo) });
    const before = await snapshot();
    const command = await peer.ghNibfin(['runner', 'remove', 'claude', '--yes']);
    const after = await snapshot();
    const local = await localState(ctx);
    // Setup only: the Owner deletes the stale registrations in Settings (out of scope),
    // so a later `runner add` does not meet a registration of the same name.
    const cleanup: string[] = [];
    const label = `nibfin-${peer.id}`;
    for (const x of after.runners.filter((y) => hasLabel(y, label))) await gh.rest('DELETE', `/repos/${repo}/actions/runners/${x.id}`, undefined, [404]);
    for (const x of (await registrations(gh, repo)).filter((y) => hasLabel(y, label))) cleanup.push(`registration ${x.name} is still on GitHub after deleting it`);
    return { reg, command, before, after, local, cleanup };
  })());
}

/** Registration, a hook probe and removal while the execution sandbox is private, once per run. */
export function privatePhase(ctx: RunContext): Promise<PrivateResult> {
  const m = memo(ctx);
  return (m.private ??= (async () => {
    if (m.registration) {
      try {
        await publicRemoval(ctx);
      } catch (error) {
        throw new Error(`the public registration and removal did not finish, so the private phase cannot start clean: ${message(error)}`, { cause: error });
      }
    }
    const gh = ctx.github;
    const repo = ctx.sandbox.execution;
    const peer = ctx.peer();
    return ctx.withExecutionVisibility('private', async () => {
      const reg = await register(ctx);
      const prober = createProber(ctx);
      try {
        const { data } = await gh.rest<{ visibility?: string }>('GET', `/repos/${repo}`);
        const mainSha = (await prober.main()).sha;
        const probe = await prober.probe('main');
        const remove = await peer.ghNibfin(['runner', 'remove', 'claude', '--yes']);
        const afterRemove = { runners: await registrations(gh, repo), keys: await deployKeys(gh, repo) };
        return { reg, visibility: String(data.visibility), mainSha, probe, remove, afterRemove, local: await localState(ctx) };
      } finally {
        await prober.cancelActive();
      }
    });
  })());
}
