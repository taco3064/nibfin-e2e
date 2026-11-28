// Proposal R5.30: `runner add` for a provider that is not logged in yet goes on to guide
// the CLI's own login. Codex has no login on the gate host, so `runner add codex` takes
// that path; the scenario stops at the guide and never authorizes. The same check is
// Proposal R5.34's first-login clause ("the first login is guided by runner add").
// Proposal R6.11: while the guide is shown, the login runs the CLI's own login in an
// interactive container from the Jobs' image; the scenario samples Podman for it.
import { CODEX_VOLUME } from '../../src/host/config.ts';
import type { RunContext } from '../../src/types.ts';
import { claudeLoggedIn, defineScenario, providerLogin, statusJson } from '../dashboard/support.ts';
import type { Secrets } from '../dashboard/support.ts';
import { tail } from '../lib/check.ts';
import { mainDigest } from '../lib/image.ts';
import { IMAGE, imageDigest } from '../lib/observed-facts.ts';
import { registrations } from '../lib/github.ts';
import type { Registration } from '../lib/github.ts';
import { listVolume } from '../lib/volume.ts';
import { describeLogin, loginVerdict, otherImageLogin, parseIds, pickLogin, projectLogin, shortId } from './login-container.ts';
import type { CurrentMain, LoginContainer } from './login-container.ts';
import { guideTail, loginGuide, statusRunners, SUCCESS_LINE, volumeContainers, volumeExists, waitForOutput } from './login-guide.ts';

const PROVIDER = 'codex';
/** Allows for the first pull of the login image. */
const GUIDE_MS = 10 * 60_000;
const CODE_MS = 30_000;
/** How long the login container is sampled for once the guide is shown. */
const LOGIN_CONTAINER_MS = 60_000;
const SAMPLE_MS = 1_000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Full IDs of the running containers that mount the Codex login volume (for sampling). */
async function runningVolumeContainers(ctx: RunContext): Promise<string[]> {
  const argv = ['podman', 'ps', '--no-trunc', '--filter', `volume=${CODEX_VOLUME}`, '--format', '{{.ID}}'];
  const r = await ctx.exec(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 5).join(' ')} exited ${r.code}: ${tail(r, 300)}`);
  return parseIds(r.stdout);
}

/** The local image id of the Jobs' pinned image `${IMAGE}@${digest}`. */
async function jobImageId(ctx: RunContext, digest: string): Promise<string> {
  const ref = `${IMAGE}@${digest}`;
  const r = await ctx.exec(['podman', 'image', 'inspect', '--format', '{{.Id}}', ref]);
  const id = r.stdout.trim();
  if (r.code !== 0 || !id) throw new Error(`run state: the Jobs' image ${ref} is not present locally (podman image inspect exited ${r.code}: ${tail(r, 300)})`);
  return id;
}

type Child = ReturnType<RunContext['startGhNibfin']>;
type SampleEnd = 'found' | 'timeout' | 'exited' | 'aborted';

/**
 * Samples the running containers on the Codex login volume every second until one is the
 * login container, the deadline passes, the child exits or the run aborts. Only the
 * allowlisted projection of each inspect document is kept (raw output never reaches a
 * log or reason); a container gone between the listing and the inspect is skipped.
 */
async function sampleLogin(ctx: RunContext, child: Child, jobId: string, ms: number): Promise<{ end: SampleEnd; match?: LoginContainer; seen: LoginContainer[] }> {
  const deadline = Date.now() + ms;
  let exited = false;
  // As in waitForOutput: a pattern that never matches rejects only when the child exits.
  child.waitFor(/(?!)/, ms + 60_000).catch(() => {
    if (Date.now() < deadline) exited = true;
  });
  const seen = new Map<string, LoginContainer>();
  const all = () => [...seen.values()];
  for (;;) {
    const list: LoginContainer[] = [];
    for (const id of await runningVolumeContainers(ctx)) {
      const r = await ctx.exec(['podman', 'container', 'inspect', id]);
      if (r.code !== 0) continue;
      let c: LoginContainer | undefined;
      try {
        c = projectLogin(JSON.parse(r.stdout));
      } catch {
        c = undefined;
      }
      if (!c) continue;
      list.push(c);
      seen.set(describeLogin(c), c);
    }
    const { match } = pickLogin(list, jobId);
    if (match) return { end: 'found', match, seen: all() };
    if (exited) return { end: 'exited', seen: all() };
    if (ctx.signal?.aborted) return { end: 'aborted', seen: all() };
    if (Date.now() >= deadline) return { end: 'timeout', seen: all() };
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(SAMPLE_MS, deadline - Date.now()))));
  }
}

/** The R6.11 outcome, held as a value so R5.30's checks and the cleanup still run. */
type LoginCheck = { pass: string } | { failure: string };

async function checkLoginContainer(ctx: RunContext, child: Child, image: { digest: string; id: string }): Promise<LoginCheck> {
  const ref = `${IMAGE}@${image.digest}`;
  let sample: Awaited<ReturnType<typeof sampleLogin>>;
  try {
    sample = await sampleLogin(ctx, child, image.id, LOGIN_CONTAINER_MS);
  } catch (e) {
    return { failure: `R6.11: sampling the login container failed: ${errorText(e)}` };
  }
  const { match } = sample;
  if (match) {
    return {
      pass: `R6.11 (Codex branch; Claude /login not exercised): login container ${shortId(match.id)} from ${ref} (image ${match.imageName || '(none)'}) ran "${match.argv.join(' ')}" with OpenStdin=${match.openStdin} Tty=${match.tty}`,
    };
  }
  // A login-shaped candidate from another image may only mean GHCR :main moved after
  // init; loginVerdict calls it run state only when it is proven to be from :main.
  let current: CurrentMain | undefined;
  if (sample.seen.some((c) => otherImageLogin(c, image.id))) {
    try {
      current = { digest: await mainDigest() };
    } catch (e) {
      current = { error: errorText(e) };
    }
    if ('digest' in current && current.digest !== image.digest) {
      // The current image may not be present locally; then only a digest match can prove it.
      const r = await ctx.exec(['podman', 'image', 'inspect', '--format', '{{.Id}}', `${IMAGE}@${current.digest}`]).catch(() => undefined);
      const id = r?.stdout.trim();
      if (r?.code === 0 && id) current = { digest: current.digest, imageId: id };
    }
  }
  const when = { exited: 'before the command exited', aborted: 'before the run budget ended the wait', timeout: `within ${LOGIN_CONTAINER_MS / 1000} s`, found: '' }[sample.end];
  return loginVerdict({ seen: sample.seen, ref, jobImageId: image.id, initDigest: image.digest, current, volume: CODEX_VOLUME, waitText: when });
}

/** Every failure here is the run's state, never R5.30. */
async function precondition(ctx: RunContext): Promise<void> {
  const status = await statusJson(ctx);
  const login = providerLogin(status, PROVIDER);
  if (login !== false) throw new Error(`gh nibfin status --json reports codex ${login ? 'logged in' : 'with no login entry'}; expected codex not logged in`);
  const runners = statusRunners(status, PROVIDER);
  if (!runners) throw new Error('gh nibfin status --json has no .host.runners.runners list to check for codex Runners');
  if (runners.length) throw new Error(`gh nibfin status --json lists ${runners.length} codex Runner(s) before runner add`);
  if (await volumeExists(ctx, CODEX_VOLUME)) {
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
    if (await volumeExists(ctx, CODEX_VOLUME)) {
      const r = await ctx.exec(['podman', 'volume', 'rm', '--force', CODEX_VOLUME]);
      if (r.code !== 0) throw new Error(`podman volume rm --force exited ${r.code}: ${tail(r, 300)}`);
    }
    const left = await volumeContainers(ctx, CODEX_VOLUME);
    if (left.length) await ctx.exec(['podman', 'rm', '--force', ...left]);
  });
  const known = new Set(before.map((r) => r.id));
  await step('deleting new registrations', async () => {
    for (const r of await registrations(ctx.github, execution)) {
      if (!known.has(r.id)) await ctx.github.rest('DELETE', `/repos/${execution}/actions/runners/${r.id}`, undefined, [404]);
    }
  });
  await step('read-back', async () => {
    if (await volumeExists(ctx, CODEX_VOLUME)) problems.push(`${CODEX_VOLUME} still exists`);
    const containers = await volumeContainers(ctx, CODEX_VOLUME);
    if (containers.length) problems.push(`${containers.length} container(s) still mount ${CODEX_VOLUME}`);
    const extra = (await registrations(ctx.github, execution)).filter((r) => !known.has(r.id));
    if (extra.length) problems.push(`${execution} still lists new registrations [${extra.map((r) => r.name).join(', ')}]`);
    const status = await statusJson(ctx);
    const codex = statusRunners(status, PROVIDER);
    if (!codex) problems.push('gh nibfin status --json has no .host.runners.runners list to check for codex Runners');
    else if (codex.length) problems.push(`gh nibfin status still lists ${codex.length} codex Runner(s)`);
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

async function attempt(ctx: RunContext, secrets: Secrets, child: Child, image: { digest: string; id: string }, login: { check?: LoginCheck }): Promise<string> {
  const remember = () => loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
  const waited = await waitForOutput(child, (o) => loginGuide(o).url, GUIDE_MS, { signal: ctx.signal });
  remember();
  if (waited.end !== 'found') {
    const out = child.output();
    const how = { exited: 'the command exited first', timeout: `no step line within ${GUIDE_MS / 60_000} min`, aborted: 'the run budget ended the wait', found: '' }[waited.end];
    const success = SUCCESS_LINE.test(out) ? '; the output shows a login success line instead of the step line' : '';
    throw new Error(`R5.30: expected runner add codex to go on to the CLI's login guide (an "open https://…" login step) without a separate login command; observed: ${how}${success}: ${guideTail(out) || '(no output)'}`);
  }
  // R6.11 while the guide is shown, before the command is stopped.
  login.check = await checkLoginContainer(ctx, child, image);
  const code = await waitForOutput(child, (o) => loginGuide(o).code, CODE_MS, { signal: ctx.signal });
  remember();
  await child.stop();
  remember();
  const after = providerLogin(await statusJson(ctx), PROVIDER);
  if (after !== false) {
    throw new Error(`R5.30: expected codex still not logged in after the guide was abandoned; observed status reports codex ${after ? 'logged in' : 'with no login entry'}: ${guideTail(child.output())}`);
  }
  return `runner add codex printed the CLI's login step "open <URL>"${code.end === 'found' ? ' and "enter code <CODE>"' : ''} unasked; abandoned, codex still not logged in`;
}

export const runnerAddLogin = defineScenario({
  id: 'runner-add-login',
  // R6.11: Codex branch only (codex login [--device-auth]); the Claude /login branch is not exercised here (the gate's Claude login must stay in place).
  rules: ['R5.30', 'R5.34', 'R6.11'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    let before: Registration[];
    let image: { digest: string; id: string };
    try {
      await precondition(ctx);
      const digest = imageDigest(ctx);
      image = { digest, id: await jobImageId(ctx, digest) };
      before = await registrations(ctx.github, ctx.sandbox.execution);
    } catch (e) {
      const text = errorText(e);
      throw new Error(/^run state: /.test(text) ? text : `run state: ${text}`, { cause: e });
    }
    const child = ctx.startGhNibfin(['runner', 'add', PROVIDER, '--count', '1', '--yes']);
    let passed: string | undefined;
    let failure: string | undefined;
    const login: { check?: LoginCheck } = {};
    try {
      passed = await attempt(ctx, secrets, child, image, login);
    } catch (e) {
      loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
      failure = errorText(e);
      if (!/^R5\.30: /.test(failure)) failure = `R5.30: the attempt failed: ${failure}`;
    }
    // Cleanup runs whatever the attempt did (a finally that merges its problems into the result).
    const problems = await cleanup(ctx, before, () => child.stop());
    loginGuide(child.output()).secrets.forEach((s) => secrets.add(s));
    // Order: cleanup problems (run state), then R5.30, then R6.11.
    const check: LoginCheck = login.check ?? { failure: 'R6.11 not checked: no login guide was shown' };
    const failures = [
      ...(problems.length ? [`run state: after runner-add-login: ${problems.join('; ')}`] : []),
      ...(failure !== undefined ? [failure] : passed === undefined ? ['R5.30: no result'] : []),
      ...('failure' in check ? [check.failure] : []),
    ];
    if (failures.length) throw new Error(failures.join('; also '));
    return `${passed}; ${'pass' in check ? check.pass : ''}; codex volume, container and registrations removed; claude Runners online and claude logged in`;
  },
});
