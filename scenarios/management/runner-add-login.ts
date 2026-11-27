// Proposal R5.30: `runner add` for a provider that is not logged in yet goes on to guide
// the CLI's own login. Codex has no login on the gate host, so `runner add codex` takes
// that path; the scenario stops at the guide and never authorizes.
import { CODEX_VOLUME } from '../../src/host/config.ts';
import type { RunContext } from '../../src/types.ts';
import { claudeLoggedIn, defineScenario, providerLogin, statusJson } from '../dashboard/support.ts';
import type { Secrets } from '../dashboard/support.ts';
import { tail } from '../lib/check.ts';
import { registrations } from '../lib/github.ts';
import type { Registration } from '../lib/github.ts';
import { listVolume } from '../lib/volume.ts';
import { guideTail, loginGuide, statusRunners, SUCCESS_LINE, waitForOutput } from './login-guide.ts';

const PROVIDER = 'codex';
/** Allows for the first pull of the login image. */
const GUIDE_MS = 10 * 60_000;
const CODE_MS = 30_000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `podman volume exists`: true, false, or throws on another error (exit 125). */
async function volumeExists(ctx: RunContext): Promise<boolean> {
  const r = await ctx.exec(['podman', 'volume', 'exists', CODEX_VOLUME]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`podman volume exists ${CODEX_VOLUME} exited ${r.code}: ${tail(r, 300)}`);
}

/** IDs of every container (running or not) that mounts the Codex login volume. */
async function volumeContainers(ctx: RunContext): Promise<string[]> {
  const r = await ctx.exec(['podman', 'ps', '-a', '--filter', `volume=${CODEX_VOLUME}`, '--format', '{{.ID}}']);
  if (r.code !== 0) throw new Error(`podman ps -a --filter volume=${CODEX_VOLUME} exited ${r.code}: ${tail(r, 300)}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Every failure here is the run's state, never R5.30. */
async function precondition(ctx: RunContext): Promise<void> {
  const status = await statusJson(ctx);
  const login = providerLogin(status, PROVIDER);
  if (login !== false) throw new Error(`gh nibfin status --json reports codex ${login ? 'logged in' : 'with no login entry'}; expected codex not logged in`);
  const runners = statusRunners(status, PROVIDER);
  if (runners.length) throw new Error(`gh nibfin status --json lists ${runners.length} codex Runner(s) before runner add`);
  if (await volumeExists(ctx)) {
    const files = await listVolume(ctx.exec, CODEX_VOLUME);
    if (files.length) throw new Error(`the Codex login volume ${CODEX_VOLUME} already holds ${files.length} file(s)`);
  }
}

/** Removes what the attempt created and checks the run can go on; returns the problems. */
async function cleanup(ctx: RunContext, before: Registration[], stop: () => Promise<unknown>): Promise<string[]> {
  const problems: string[] = [];
  const step = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${what}: ${errorText(e)}`);
    }
  };
  const { execution } = ctx.sandbox;
  await step('stopping runner add', async () => void (await stop()));
  await step('runner remove codex', async () => {
    const r = await ctx.ghNibfin(['runner', 'remove', PROVIDER, '--delete-login', '--yes']);
    if (r.code !== 0) ctx.log(`runner remove codex --delete-login --yes exited ${r.code} (noted, not fatal): ${tail(r, 300)}`);
  });
  await step(`removing ${CODEX_VOLUME}`, async () => {
    if (await volumeExists(ctx)) {
      const r = await ctx.exec(['podman', 'volume', 'rm', '--force', CODEX_VOLUME]);
      if (r.code !== 0) throw new Error(`podman volume rm --force exited ${r.code}: ${tail(r, 300)}`);
    }
    const left = await volumeContainers(ctx);
    if (left.length) await ctx.exec(['podman', 'rm', '--force', ...left]);
  });
  const known = new Set(before.map((r) => r.id));
  await step('deleting new registrations', async () => {
    for (const r of await registrations(ctx.github, execution)) {
      if (!known.has(r.id)) await ctx.github.rest('DELETE', `/repos/${execution}/actions/runners/${r.id}`, undefined, [404]);
    }
  });
  await step('read-back', async () => {
    if (await volumeExists(ctx)) problems.push(`${CODEX_VOLUME} still exists`);
    const containers = await volumeContainers(ctx);
    if (containers.length) problems.push(`${containers.length} container(s) still mount ${CODEX_VOLUME}`);
    const extra = (await registrations(ctx.github, execution)).filter((r) => !known.has(r.id));
    if (extra.length) problems.push(`${execution} still lists new registrations [${extra.map((r) => r.name).join(', ')}]`);
    const status = await statusJson(ctx);
    const codex = statusRunners(status, PROVIDER);
    if (codex.length) problems.push(`gh nibfin status still lists ${codex.length} codex Runner(s)`);
    // Run-state guard, as in dashboard-login-relay: later scenarios need claude's login and Runners.
    if (!claudeLoggedIn(status)) problems.push('claude is no longer logged in');
    const online = before.filter((r) => r.status === 'online');
    if (online.length) {
      let missing: string[] = [];
      for (let i = 0; i < 6; i++) {
        const now = new Map((await registrations(ctx.github, execution)).map((r) => [r.id, r]));
        missing = online.filter((r) => now.get(r.id)?.status !== 'online').map((r) => `${r.name} (${now.get(r.id)?.status ?? 'gone'})`);
        if (!missing.length) break;
        await new Promise((r) => setTimeout(r, 10_000));
      }
      if (missing.length) problems.push(`Runners online before are no longer online: ${missing.join(', ')}`);
    }
  });
  return problems;
}

async function attempt(ctx: RunContext, secrets: Secrets, child: ReturnType<RunContext['startGhNibfin']>): Promise<string> {
  const remember = () => loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
  const waited = await waitForOutput(child, (o) => loginGuide(o).url, GUIDE_MS, { signal: ctx.signal });
  remember();
  if (waited.end !== 'found') {
    const out = child.output();
    const how = { exited: 'the command exited first', timeout: `no step line within ${GUIDE_MS / 60_000} min`, aborted: 'the run budget ended the wait', found: '' }[waited.end];
    const success = SUCCESS_LINE.test(out) ? '; the output shows a login success line instead of the step line' : '';
    throw new Error(`R5.30: expected runner add codex to go on to the CLI's login guide (an "open https://…" login step) without a separate login command; observed: ${how}${success}: ${guideTail(out) || '(no output)'}`);
  }
  const code = await waitForOutput(child, (o) => loginGuide(o).code, CODE_MS, { signal: ctx.signal });
  remember();
  // Supporting evidence only (R6.11 context); never fails.
  const ps = await ctx.exec(['podman', 'ps', '--filter', `volume=${CODEX_VOLUME}`, '--format', '{{.Image}}']);
  const images = ps.code === 0 ? [...new Set(ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean))] : [];
  await child.stop();
  remember();
  const after = providerLogin(await statusJson(ctx), PROVIDER);
  if (after !== false) {
    throw new Error(`R5.30: expected codex still not logged in after the guide was abandoned; observed status reports codex ${after ? 'logged in' : 'with no login entry'}: ${guideTail(child.output())}`);
  }
  const container = images.length ? `; the login ran in a container from ${images.join(', ')}` : '; no container mounting the login volume was seen';
  return `runner add codex printed the CLI's login step "open <URL>"${code.end === 'found' ? ' and "enter code <CODE>"' : ''} unasked${container}; abandoned, codex still not logged in`;
}

export const runnerAddLogin = defineScenario({
  id: 'runner-add-login',
  rules: ['R5.30'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    let before: Registration[];
    try {
      await precondition(ctx);
      before = await registrations(ctx.github, ctx.sandbox.execution);
    } catch (e) {
      throw new Error(`run state: ${errorText(e)}`, { cause: e });
    }
    const child = ctx.startGhNibfin(['runner', 'add', PROVIDER, '--count', '1', '--yes']);
    let passed: string | undefined;
    let failure: string | undefined;
    try {
      passed = await attempt(ctx, secrets, child);
    } catch (e) {
      loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
      failure = errorText(e);
      if (!/^R5\.30: /.test(failure)) failure = `R5.30: the attempt failed: ${failure}`;
    }
    // Cleanup runs whatever the attempt did (a finally that merges its problems into the result).
    const problems = await cleanup(ctx, before, () => child.stop());
    loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
    if (problems.length) throw new Error(`run state: after runner-add-login: ${problems.join('; ')}${failure ? `; also ${failure}` : ''}`);
    if (failure !== undefined || passed === undefined) throw new Error(failure ?? 'R5.30: no result');
    return `${passed}; codex volume, container and registrations removed; claude Runners online and claude logged in`;
  },
});
