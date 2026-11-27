import { join } from 'node:path';
import type { Outcome, Scenario } from '../../src/types.ts';
import { createProber } from './hook.ts';
import type { ProbeCase, ProbeResult } from './hook.ts';
import { hasLabel, registrations } from './observe.ts';
import type { Registration } from './observe.ts';
import { checkStatus, keyBody, parseRequestBody } from './parse.ts';
import { privatePhase, publicRegistration, publicRemoval } from './phases.ts';
import type { LocalState, Registered } from './phases.ts';

const TEN_MINUTES = 10 * 60_000;
const base = { platforms: ['linux' as const], requires: ['collaborator'] };

function outcome(problems: string[], passed: string): Outcome {
  return problems.length ? { status: 'failed', reason: problems.join('; ') } : { status: 'passed', reason: passed };
}

const tail = (s: string) => s.trim().slice(-1500);
const names = (rs: Registration[]) => rs.map((r) => `${r.name} (${r.status})`).join(', ') || 'none';

/** R5.60 for one registration: registered and exited within 10 minutes of the request, the Issue closed completed. */
function registeredInTime(reg: Registered, login: string, problems: string[]): void {
  const issue = reg.issues[0];
  if (reg.command.code !== 0) problems.push(`R5.60: runner add exited ${reg.command.code}: ${tail(reg.command.stderr || reg.command.stdout)}`);
  if (!reg.added.length) problems.push(`R5.60: no new registration with the collaborator's label; registrations: ${names(reg.after)}`);
  if (!issue) return;
  const took = reg.exitedAt - Date.parse(issue.created_at);
  if (took > TEN_MINUTES) problems.push(`R5.60: runner add exited ${Math.round(took / 1000)} s after the request Issue was opened, more than 10 minutes`);
  if (issue.state !== 'closed' || issue.state_reason !== 'completed') {
    problems.push(`R5.60: request Issue #${issue.number} is ${issue.state}/${String(issue.state_reason)}, expected closed as completed`);
  }
  const named = reg.comments.some((c) => c.user.login === login && reg.added.every((a) => (c.body ?? '').includes(a.name)));
  if (reg.added.length && !named) problems.push(`R5.60: no comment by ${login} on #${issue.number} names the registered runner ${reg.added.map((a) => a.name).join(', ')}`);
}

/** R5.58: exactly one fixed-format request Issue by the collaborator. */
function requestIssue(reg: Registered, login: string, keyId: number, problems: string[]): void {
  if (reg.issues.length !== 1) {
    problems.push(`R5.58: expected exactly one "Nibfin runner request" Issue by ${login}, found ${reg.issues.length}`);
    return;
  }
  const issue = reg.issues[0] as Registered['issues'][number];
  const body = parseRequestBody(issue.body);
  if (issue.user.login !== login) problems.push(`R5.58: request Issue #${issue.number} is authored by ${issue.user.login}, expected ${login}`);
  if (!body.marker) problems.push(`R5.58: request Issue #${issue.number} has no <!-- nibfin:runner-request --> line`);
  if (body.sshKeyIds.length !== 1 || body.sshKeyIds[0] !== String(keyId)) {
    problems.push(`R5.58: request Issue #${issue.number} has ssh-key-id lines [${body.sshKeyIds.join(', ')}], expected exactly ${keyId}`);
  }
}

/** R5.63's local half: no unit, no Runner directory and no hook directory left. */
function localCleared(local: LocalState, problems: string[]): void {
  if (local.units.length) problems.push(`R5.63: units left on the collaborator's host: ${local.units.join(', ')}`);
  if (local.runnerDirs.length) problems.push(`R5.63: Runner directories left: ${local.runnerDirs.join(', ')}`);
  if (local.hook) problems.push('R5.63: the hook directory is still on the collaborator\'s host');
}

export const collaboratorRegister: Scenario = {
  id: 'collaborator-register',
  rules: ['R5.57', 'R5.58', 'R5.59', 'R5.60', 'R5.62'],
  ...base,
  async run(ctx) {
    const peer = ctx.peer();
    const reg = await publicRegistration(ctx);
    const problems: string[] = [];
    const label = `nibfin-${peer.id}`;

    // R5.57: a write collaborator registers with no approval step by the harness.
    if (reg.permission !== 'write') problems.push(`R5.57: ${peer.login} has ${reg.permission} permission, expected write`);
    for (const a of reg.added) if (hasLabel(a, 'nibfin')) problems.push(`R5.57: registration ${a.name} has the Owner's label nibfin`);
    if (reg.added.length && reg.online === null) problems.push(`R5.57: the collaborator's registrations are not online: ${names(reg.added)}`);

    requestIssue(reg, peer.login, peer.keyId, problems);

    // R5.59: answered by the workflow on a GitHub-hosted Runner, encrypted to the key.
    if (!reg.run) problems.push('R5.59: no completed nibfin-runner-request.yml run for the request Issue');
    else if (reg.run.conclusion !== 'success') problems.push(`R5.59: nibfin-runner-request.yml run ${reg.run.id} concluded ${String(reg.run.conclusion)}`);
    if (reg.run && !reg.job) problems.push(`R5.59: run ${reg.run.id} has no job`);
    if (reg.job) {
      if (JSON.stringify(reg.job.labels) !== JSON.stringify(['ubuntu-24.04'])) problems.push(`R5.59: the request job ran with labels ${JSON.stringify(reg.job.labels)}, expected ["ubuntu-24.04"]`);
      const selfHosted = [...reg.before, ...reg.after].map((r) => r.name);
      if (reg.job.runner_name && selfHosted.includes(reg.job.runner_name)) problems.push(`R5.59: the request job ran on the self-hosted runner ${reg.job.runner_name}`);
    }
    if (!reg.answer) problems.push('R5.59: no github-actions[bot] comment starting with <!-- nibfin:runner-registration -->');
    else {
      const a = reg.answer.parsed;
      if (a.requester !== peer.login) problems.push(`R5.59: the answer is for requester ${a.requester}, expected ${peer.login}`);
      if (a.sshKeyId !== String(peer.keyId)) problems.push(`R5.59: the answer is for ssh-key-id ${a.sshKeyId}, expected ${peer.keyId}`);
      if (!a.armored) problems.push('R5.59: the answer has no armored age block');
    }

    registeredInTime(reg, peer.login, problems);

    // R5.62: a public execution repository needs no key.
    const issue = reg.issues[0];
    if (issue && parseRequestBody(issue.body).deployKeys.length) problems.push(`R5.62: request Issue #${issue.number} has a deploy-key line on a public repository`);
    if (reg.deployKeys.length) problems.push(`R5.62: the execution sandbox has deploy keys ${reg.deployKeys.map((k) => k.title).join(', ')}`);
    if (await peer.stat(reg.deployKeyDir)) problems.push(`R5.62: ${reg.deployKeyDir} exists on the collaborator's host`);

    return outcome(
      problems,
      `${peer.login} (write) opened request #${issue?.number}, answered by run ${reg.run?.id} on ${reg.job?.runner_name}; registered ${names(reg.added)} with ${label} in ${Math.round((reg.exitedAt - reg.startedAt) / 1000)} s; no deploy key`,
    );
  },
};

export const collaboratorStatus: Scenario = {
  id: 'collaborator-status',
  rules: ['R5.64'],
  ...base,
  async run(ctx) {
    const peer = ctx.peer();
    const reg = await publicRegistration(ctx);
    if (!reg.added.length) return { status: 'failed', reason: `R5.64 needs a registered collaborator Runner; runner add exited ${reg.command.code}` };
    const r = await peer.ghNibfin(['status', '--json']);
    if (r.code !== 0) return { status: 'failed', reason: `R5.64: gh nibfin status --json exited ${r.code}: ${tail(r.stderr || r.stdout)}` };
    let doc: unknown;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      return { status: 'failed', reason: 'R5.64: gh nibfin status --json did not print JSON' };
    }
    const all = await registrations(ctx.github, ctx.sandbox.execution);
    const label = `nibfin-${peer.id}`;
    const owner = all.filter((x) => !hasLabel(x, label));
    const mine = all.filter((x) => hasLabel(x, label));
    const problems = checkStatus(doc, mine.length, owner.map((x) => x.name)).map((p) => `R5.64: ${p}`);
    // GitHub (as admin) does show what the collaborator's status cannot.
    if (!owner.length || owner.some((x) => x.status !== 'online')) problems.push(`R5.64: the Owner's registrations should be online on GitHub: ${names(owner)}`);
    if (mine.some((x) => x.status !== 'online')) problems.push(`R5.64: the collaborator's registration should be online on GitHub: ${names(mine)}`);
    return outcome(problems, `status shows ${mine.length} local Runner(s), githubNeedsAdmin, no GitHub state; GitHub shows ${names(all)}`);
  },
};

export const collaboratorHook: Scenario = {
  id: 'collaborator-hook',
  rules: ['R5.65', 'R6.7'],
  ...base,
  async run(ctx) {
    const reg = await publicRegistration(ctx);
    if (!reg.added.length) return { status: 'failed', reason: `R6.7 needs a registered collaborator Runner; runner add exited ${reg.command.code}` };
    const digest = ctx.facts('nibfin')?.imageDigest;
    const prober = createProber(ctx);
    const results: ProbeResult[] = [];
    let mainSha: string | undefined;
    try {
      mainSha = (await prober.main()).sha;
      for (const c of ['main', 'control', 'template', 'digest', 'rogue'] as ProbeCase[]) {
        ctx.log(`hook probe ${c}`);
        results.push(await prober.probe(c));
      }
    } finally {
      await prober.cancelActive();
    }
    const problems: string[] = [];
    const lines: string[] = [];
    const control = results.find((x) => x.case === 'control');
    const isolated = control?.classified.kind === 'accepted';
    for (const p of results) {
      const k = p.classified;
      const seen = k.kind === 'accepted' ? `accepted ${k.repo}@${k.sha}, image ${k.digest}` : k.kind === 'refused' ? `refused: ${k.reason}` : `invalid: ${k.why}`;
      lines.push(`${p.case} (${p.ref}, run ${p.runId ?? '-'}): ${seen}`);
      const want = p.case === 'main' || p.case === 'control' ? 'accepted' : 'refused';
      if (k.kind !== want) problems.push(`R6.7 ${p.case}: expected ${want}, got ${seen}`);
      else if ((p.case === 'template' || p.case === 'digest') && !isolated) problems.push(`R6.7 ${p.case}: refused, but not isolated because the control dispatch on a branch was not accepted`);
      if (p.case === 'main' && k.kind === 'accepted') {
        if (k.repo !== ctx.sandbox.execution || k.sha !== mainSha) problems.push(`R6.7 main: accepted ${k.repo}@${k.sha}, expected ${ctx.sandbox.execution}@${mainSha}`);
        if (k.digest !== digest) problems.push(`R6.7 main: accepted image ${k.digest}, expected the init digest ${String(digest)}`);
      }
    }
    return outcome(problems, lines.join('; '));
  },
};

export const collaboratorRemove: Scenario = {
  id: 'collaborator-remove',
  rules: ['R5.63'],
  ...base,
  async run(ctx) {
    const peer = ctx.peer();
    const rm = await publicRemoval(ctx);
    if (!rm.reg.added.length) return { status: 'failed', reason: `R5.63 needs a registered collaborator Runner; runner add exited ${rm.reg.command.code}` };
    const problems: string[] = [];
    if (rm.command.code !== 0) problems.push(`R5.63: runner remove exited ${rm.command.code}: ${tail(rm.command.stderr || rm.command.stdout)}`);
    localCleared(rm.local, problems);
    const ids = (rs: { id: number }[]) => rs.map((x) => x.id).sort((a, b) => a - b).join(',');
    if (ids(rm.before.runners) !== ids(rm.after.runners)) problems.push(`R5.63: GitHub's registrations changed: before ${names(rm.before.runners)}, after ${names(rm.after.runners)}`);
    if (ids(rm.before.keys) !== ids(rm.after.keys)) problems.push('R5.63: GitHub\'s deploy keys changed');
    for (const a of rm.reg.added) if (!rm.after.runners.some((x) => x.id === a.id)) problems.push(`R5.63: the collaborator's registration ${a.name} is no longer on GitHub`);
    const label = `nibfin-${peer.id}`;
    const owner = rm.after.runners.filter((x) => !hasLabel(x, label));
    if (!owner.length || owner.some((x) => x.status !== 'online')) problems.push(`R5.63: the Owner's registrations should be unchanged and online: ${names(owner)}`);
    if (rm.cleanup.length) ctx.log(`setup cleanup: ${rm.cleanup.join('; ')}`);
    return outcome(problems, `local Runners and hook removed; GitHub still lists ${names(rm.after.runners)}`);
  },
};

export const collaboratorPrivate: Scenario = {
  id: 'collaborator-private',
  rules: ['R5.61', 'R6.8', 'R5.63'],
  ...base,
  async run(ctx) {
    const peer = ctx.peer();
    const p = await privatePhase(ctx);
    const reg = p.reg;
    const problems: string[] = [];
    const issue = reg.issues[0];
    const title = `nibfin-runner-${peer.login}`;

    // R5.61: a dedicated key outside the Runner directories, added as a read-only deploy key.
    requestIssue(reg, peer.login, peer.keyId, problems);
    const lines = issue ? parseRequestBody(issue.body).deployKeys : [];
    if (lines.length !== 1 || !/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(lines[0] ?? '')) problems.push(`R5.61: request has deploy-key lines [${lines.join(' | ')}], expected one ssh-ed25519 key`);
    // Read after runner add and before runner remove.
    const keyFile = join(reg.deployKeyDir, 'id_ed25519');
    const host = p.keyOnHost;
    const pub = 'text' in host.pub ? keyBody(host.pub.text) : '';
    if ('error' in host.pub) problems.push(`R5.61: ${keyFile}.pub cannot be read: ${host.pub.error}`);
    if (pub && lines[0] !== pub) problems.push(`R5.61: the request's deploy key is not the host's ${keyFile}.pub`);
    const fileStat = host.file;
    const dirStat = host.dir;
    if (fileStat?.mode !== '600' || fileStat.type !== 'regular file') problems.push(`R5.61: ${keyFile} is ${fileStat ? `${fileStat.type} ${fileStat.mode}` : 'missing'}, expected a 0600 file`);
    if (dirStat?.mode !== '700') problems.push(`R5.61: ${reg.deployKeyDir} is ${dirStat ? dirStat.mode : 'missing'}, expected 0700`);
    const runnersDir = join(peer.dataHome, 'nibfin', 'runners');
    if (reg.deployKeyDir.startsWith(runnersDir + '/')) problems.push(`R5.61: the deploy key is under ${runnersDir}`);
    if (host.inRunners) problems.push(`R5.61: key files under the Runner directories: ${host.inRunners}`);
    const key = reg.deployKeys.find((k) => k.title === title);
    if (!key) problems.push(`R5.61: no deploy key ${title} on the execution sandbox (keys: ${reg.deployKeys.map((k) => k.title).join(', ') || 'none'})`);
    else {
      if (key.read_only !== true) problems.push(`R5.61: deploy key ${title} is not read-only`);
      if (pub && keyBody(key.key) !== pub) problems.push(`R5.61: deploy key ${title} is not the host's key`);
    }
    registeredInTime(reg, peer.login, problems);

    // R6.8: the hook reads the private repository with that key and accepts the official Job.
    if (p.visibility !== 'private') problems.push(`R6.8: the execution sandbox read back ${p.visibility} during the probe`);
    const k = p.probe.classified;
    if (k.kind !== 'accepted') problems.push(`R6.8: the official Job on main was ${k.kind === 'refused' ? `refused: ${k.reason}` : `not classified: ${k.why}`}`);
    else if (k.sha !== p.mainSha || k.repo !== ctx.sandbox.execution) problems.push(`R6.8: accepted ${k.repo}@${k.sha}, expected ${ctx.sandbox.execution}@${p.mainSha}`);

    // R5.63: removal is local; the deploy key and the registration stay for the Owner.
    if (p.remove.code !== 0) problems.push(`R5.63: runner remove exited ${p.remove.code}: ${tail(p.remove.stderr || p.remove.stdout)}`);
    localCleared(p.local, problems);
    if (!p.afterRemove.keys.some((x) => x.title === title)) problems.push(`R5.63: deploy key ${title} is gone from GitHub after runner remove`);
    for (const a of reg.added) if (!p.afterRemove.runners.some((x) => x.id === a.id)) problems.push(`R5.63: registration ${a.name} is gone from GitHub after runner remove`);

    if (p.cleanup.length) ctx.log(`setup cleanup: ${p.cleanup.join('; ')}`);
    return outcome(problems, `private: deploy key ${title} (read-only) from ${keyFile}; hook accepted ${ctx.sandbox.execution}@${p.mainSha}; remove left the key and ${names(reg.added)} on GitHub`);
  },
};

export const collaboratorScenarios: Scenario[] = [collaboratorRegister, collaboratorStatus, collaboratorHook, collaboratorRemove, collaboratorPrivate];
