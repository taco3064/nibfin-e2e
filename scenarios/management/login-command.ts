// Proposal R5.34: `login [claude|codex]` logs in again through the CLI's own login (§6); the
// first login is guided by `runner add` (checked by runner-add-login); `login` is not offered
// when the host has no Runner of that provider. Claude is logged in and has Runners on the gate
// host, codex has neither: `login claude` must reach the CLI's login guide (abandoned there,
// never authorized) and `login codex` must be refused without starting anything.
import { CLAUDE_VOLUME, CODEX_VOLUME } from '../../src/host/config.ts';
import type { RunContext } from '../../src/types.ts';
import { claudeLoggedIn, defineScenario, statusJson } from '../dashboard/support.ts';
import type { Secrets } from '../dashboard/support.ts';
import { registrations } from '../lib/github.ts';
import type { Registration } from '../lib/github.ts';
import { guideTail, loginGuide, loginRefusal, PASTE_PROMPT, statusRunners, SUCCESS_LINE, volumeContainers, volumeExists, waitForOutput } from './login-guide.ts';

/** Allows for `--pull=newer` of the login image. */
const GUIDE_MS = 10 * 60_000;
const PROMPT_MS = 30_000;
const GONE_MS = 10_000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Snapshot {
  before: Registration[];
  codexVolume: boolean;
  claudeContainers: Set<string>;
  codexContainers: Set<string>;
}

/** Every failure here is the run's state, never R5.34. */
async function precondition(ctx: RunContext): Promise<Snapshot> {
  const status = await statusJson(ctx);
  if (!claudeLoggedIn(status)) throw new Error('gh nibfin status --json does not report claude logged in; expected the provisioned claude login');
  const claude = statusRunners(status, 'claude');
  const codex = statusRunners(status, 'codex');
  if (!claude || !codex) throw new Error('gh nibfin status --json has no .host.runners.runners list to check for claude and codex Runners');
  if (!claude.length) throw new Error('gh nibfin status --json lists no claude Runner on this host; expected the provisioned claude Runners');
  if (codex.length) throw new Error(`gh nibfin status --json lists ${codex.length} codex Runner(s) on this host; expected none`);
  return {
    before: await registrations(ctx.github, ctx.sandbox.execution),
    codexVolume: await volumeExists(ctx, CODEX_VOLUME),
    claudeContainers: new Set(await volumeContainers(ctx, CLAUDE_VOLUME)),
    codexContainers: new Set(await volumeContainers(ctx, CODEX_VOLUME)),
  };
}

const fresh = async (ctx: RunContext, volume: string, known: Set<string>) => (await volumeContainers(ctx, volume)).filter((id) => !known.has(id));

/** `login claude`: the CLI's own login guide while claude is logged in; abandoned at the guide. */
async function relogin(ctx: RunContext, snap: Snapshot, secrets: Secrets, child: ReturnType<RunContext['startGhNibfin']>): Promise<string> {
  const remember = () => loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
  const waited = await waitForOutput(child, (o) => loginGuide(o).url, GUIDE_MS, { signal: ctx.signal });
  remember();
  if (waited.end !== 'found') {
    const out = child.output();
    const how = { exited: 'the command exited first', timeout: `no step line within ${GUIDE_MS / 60_000} min`, aborted: 'the run budget ended the wait', found: '' }[waited.end];
    const success = SUCCESS_LINE.test(out) ? '; the output shows a login success line instead' : '';
    throw new Error(`R5.34: expected gh nibfin login claude to go on to the CLI's own login and print its guide (an "open https://…" step) while claude is logged in; observed: ${how}${success}: ${guideTail(out) || '(no output)'}`);
  }
  const prompt = await waitForOutput(child, (o) => (PASTE_PROMPT.test(o) ? true : undefined), PROMPT_MS, { signal: ctx.signal });
  remember();
  // Supporting evidence only (R6.11 context); never fails.
  let images: string[] = [];
  try {
    const ids = await fresh(ctx, CLAUDE_VOLUME, snap.claudeContainers);
    if (ids.length) {
      const ps = await ctx.exec(['podman', 'ps', '-a', ...ids.flatMap((id) => ['--filter', `id=${id}`]), '--format', '{{.Image}}']);
      if (ps.code === 0) images = [...new Set(ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
    }
  } catch (e) {
    ctx.log(`reading the login container's image failed (noted, not fatal): ${errorText(e)}`);
  }
  // Abandon: never write to stdin, stop the whole process group.
  await child.stop();
  remember();
  const end = Date.now() + GONE_MS;
  let left = await fresh(ctx, CLAUDE_VOLUME, snap.claudeContainers);
  while (left.length && Date.now() < end) {
    await sleep(1000);
    left = await fresh(ctx, CLAUDE_VOLUME, snap.claudeContainers);
  }
  if (left.length) ctx.log(`${left.length} login container(s) on ${CLAUDE_VOLUME} still there ${GONE_MS / 1000} s after stopping login claude; cleanup removes them`);
  const container = images.length ? `; login container from ${images.join(', ')}` : '';
  return `gh nibfin login claude went on to the CLI's own login and printed "open <URL>"${prompt.end === 'found' ? ' and the paste prompt' : ''} while claude was logged in${container}; abandoned`;
}

/** `login codex` with no codex Runner: refused, and nothing started. */
async function refusal(ctx: RunContext, snap: Snapshot, secrets: Secrets): Promise<string> {
  const r = await ctx.ghNibfin(['login', 'codex'], { input: '' });
  const out = `${r.stdout}\n${r.stderr}`;
  loginGuide(out).secrets.forEach((s) => secrets.add(s));
  const seen = loginRefusal(r.code, out, 'codex');
  if (!seen.refused) {
    throw new Error(`R5.34: expected gh nibfin login codex to be refused (non-zero exit naming the missing codex Runner or runner add) on a host with no codex Runner; observed: exit ${r.code}${seen.guide ? ', a login guide' : ''}: ${guideTail(out) || '(no output)'}`);
  }
  const problems: string[] = [];
  if ((await volumeExists(ctx, CODEX_VOLUME)) !== snap.codexVolume) problems.push(`the Codex login volume ${CODEX_VOLUME} ${snap.codexVolume ? 'is gone' : 'was created'}`);
  const started = await fresh(ctx, CODEX_VOLUME, snap.codexContainers);
  if (started.length) problems.push(`${started.length} new container(s) mount ${CODEX_VOLUME}`);
  if (problems.length) throw new Error(`R5.34: expected gh nibfin login codex to start no login, container or volume when refused; observed: ${problems.join('; ')}: ${guideTail(out) || '(no output)'}`);
  return `gh nibfin login codex was refused (exit ${r.code}, names the missing Runner) and started no login, container or volume`;
}

/** Removes containers the attempt left and checks the run can go on; returns the problems. */
async function cleanup(ctx: RunContext, snap: Snapshot, stop: () => Promise<unknown>): Promise<string[]> {
  const problems: string[] = [];
  const step = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${what}: ${errorText(e)}`);
    }
  };
  await step('stopping login claude', async () => void (await stop()));
  for (const [volume, known] of [[CLAUDE_VOLUME, snap.claudeContainers], [CODEX_VOLUME, snap.codexContainers]] as const) {
    await step(`removing new containers on ${volume}`, async () => {
      const ids = await fresh(ctx, volume, known);
      if (ids.length) await ctx.exec(['podman', 'rm', '--force', ...ids]);
      const left = await fresh(ctx, volume, known);
      if (left.length) problems.push(`${left.length} new container(s) still mount ${volume}`);
    });
  }
  // Run-state guard, as in dashboard-login-relay: later scenarios need claude's login and Runners.
  await step('read-back', async () => {
    if (!claudeLoggedIn(await statusJson(ctx))) problems.push('claude is no longer logged in');
    const online = snap.before.filter((r) => r.status === 'online');
    if (online.length) {
      let missing: string[] = [];
      for (let i = 0; i < 6; i++) {
        const now = new Map((await registrations(ctx.github, ctx.sandbox.execution)).map((r) => [r.id, r]));
        missing = online.filter((r) => now.get(r.id)?.status !== 'online').map((r) => `${r.name} (${now.get(r.id)?.status ?? 'gone'})`);
        if (!missing.length) break;
        await sleep(10_000);
      }
      if (missing.length) problems.push(`Runners online before are no longer online: ${missing.join(', ')}`);
    }
  });
  return problems;
}

export const loginCommand = defineScenario({
  id: 'login-command',
  rules: ['R5.34'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    let snap: Snapshot;
    try {
      snap = await precondition(ctx);
    } catch (e) {
      throw new Error(`run state: ${errorText(e)}`, { cause: e });
    }
    const child = ctx.startGhNibfin(['login', 'claude']);
    const passed: string[] = [];
    let failure: string | undefined;
    try {
      passed.push(await relogin(ctx, snap, secrets, child));
      passed.push(await refusal(ctx, snap, secrets));
    } catch (e) {
      failure = errorText(e);
      if (!/^R5\.34: /.test(failure)) failure = `R5.34: the attempt failed: ${failure}`;
    } finally {
      loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
    }
    // Cleanup runs whatever the attempt did (a finally that merges its problems into the result).
    const problems = await cleanup(ctx, snap, () => child.stop());
    loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
    if (problems.length) throw new Error(`run state: after login-command: ${problems.join('; ')}${failure ? `; also ${failure}` : ''}`);
    if (failure !== undefined) throw new Error(failure);
    return `${passed.join('; ')}; claude still logged in, claude Runners online`;
  },
});
