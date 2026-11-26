import { createHash } from 'node:crypto';
import { HOOK_ACCEPTED, HOOK_REFUSED } from '../../src/host/config.ts';

/** The fixed parts of a runner request Issue body (Proposal R5.58, R5.61). */
export interface RequestBody {
  marker: boolean;
  sshKeyIds: string[];
  deployKeys: string[];
}

export function parseRequestBody(body: string | null | undefined): RequestBody {
  const lines = (body ?? '').split(/\r?\n/).map((l) => l.trim());
  return {
    marker: lines.includes('<!-- nibfin:runner-request -->'),
    sshKeyIds: lines.flatMap((l) => /^ssh-key-id:\s*(\S+)$/.exec(l)?.[1] ?? []),
    deployKeys: lines.filter((l) => /^deploy-key:/.test(l)).map((l) => l.replace(/^deploy-key:\s*/, '')),
  };
}

/** The workflow's answer comment (Proposal R5.59); undefined when the body is not one. */
export interface RegistrationComment {
  requester: string;
  sshKeyId: string;
  expiresAt: string;
  armored: boolean;
}

export function parseRegistrationComment(body: string | null | undefined): RegistrationComment | undefined {
  const text = body ?? '';
  if (!text.trimStart().startsWith('<!-- nibfin:runner-registration -->')) return undefined;
  const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm').exec(text)?.[1];
  const requester = field('requester');
  const sshKeyId = field('ssh-key-id');
  const expiresAt = field('expires-at');
  if (requester === undefined || sshKeyId === undefined || expiresAt === undefined) return undefined;
  const armored = /-----BEGIN AGE ENCRYPTED FILE-----[\s\S]+-----END AGE ENCRYPTED FILE-----/.test(text);
  return { requester, sshKeyId, expiresAt, armored };
}

/** The first two fields of an OpenSSH public key line (type and base64), without the comment. */
export const keyBody = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(' ');

export interface Job {
  id: number;
  run_id: number;
  status: string;
  conclusion: string | null;
  labels: string[];
  runner_name: string | null;
  head_sha: string;
}

export type Classified =
  | { kind: 'accepted'; repo: string; sha: string; digest: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'invalid'; why: string };

/**
 * Classifies a finished Job on the peer's label from its log (Proposal R6.7).
 * Accepted: the hook's accepted line and a step ran. Refused: the Job failed, the hook
 * refused, and no step ran (`stepMarkers` are lines only a step prints).
 */
export function classifyJob(job: Job, log: string, peerRunners: string[], stepMarkers: string[]): Classified {
  if (job.status !== 'completed') return { kind: 'invalid', why: `job ${job.id} is ${job.status}` };
  if (!job.runner_name || !peerRunners.includes(job.runner_name)) {
    return { kind: 'invalid', why: `job ${job.id} ran on ${job.runner_name ?? 'no runner'}, not on the collaborator's Runners (${peerRunners.join(', ') || 'none'})` };
  }
  const ranStep = stepMarkers.filter((m) => log.includes(m));
  const accepted = HOOK_ACCEPTED.exec(log);
  const refused = HOOK_REFUSED.exec(log);
  if (accepted && refused) return { kind: 'invalid', why: `job ${job.id} log has both an accepted and a refused hook line` };
  if (accepted) {
    if (!log.includes('Nibfin image:')) return { kind: 'invalid', why: `job ${job.id} was accepted but no step printed "Nibfin image:"` };
    return { kind: 'accepted', repo: accepted[1] as string, sha: accepted[2] as string, digest: accepted[3] as string };
  }
  if (refused) {
    if (job.conclusion !== 'failure') return { kind: 'invalid', why: `job ${job.id} was refused but concluded ${String(job.conclusion)}` };
    if (ranStep.length) return { kind: 'invalid', why: `job ${job.id} was refused but a step ran (${ranStep.join(', ')})` };
    return { kind: 'refused', reason: (refused[1] as string).trim() };
  }
  return { kind: 'invalid', why: `job ${job.id} (${String(job.conclusion)}) log has no Nibfin hook line` };
}

/** `nibfin-shared-runner.yml` with one comment line appended: the only change. */
export function tamperTemplate(text: string, nonce: string): string {
  return `${text}${text.endsWith('\n') ? '' : '\n'}# e2e tampered ${nonce}\n`;
}

/** A well-formed digest no attestation exists for. */
export const unsignedDigest = (nonce: string) => `sha256:${createHash('sha256').update(`nibfin-e2e ${nonce}`).digest('hex')}`;

/** `nibfin-job.yml` with only the digest on its single `IMAGE_REF:` line replaced. */
export function replaceDigest(text: string, digest: string): string {
  const lines = text.split('\n');
  const at = lines.flatMap((l, i) => (/^\s*IMAGE_REF:.*@sha256:[0-9a-f]{64}\s*$/.test(l) ? [i] : []));
  if (at.length !== 1) throw new Error(`nibfin-job.yml has ${at.length} IMAGE_REF lines with a digest, expected exactly one`);
  const i = at[0] as number;
  lines[i] = (lines[i] as string).replace(/sha256:[0-9a-f]{64}/, digest);
  return lines.join('\n');
}

/** A workflow outside the official template that targets the collaborator's Runners. */
export function rogueWorkflow(branch: string, peerId: number, nonce: string): string {
  return [
    'name: e2e rogue',
    'on:',
    '  push:',
    `    branches: [${JSON.stringify(branch)}]`,
    'jobs:',
    '  rogue:',
    `    runs-on: [self-hosted, "nibfin-${peerId}"]`,
    '    steps:',
    `      - run: echo e2e-rogue-step-${nonce}`,
    '',
  ].join('\n');
}

/** What R5.64 asks of the collaborator's `status --json`; returns the problems found. */
export function checkStatus(doc: unknown, peerRunnerCount: number, ownerRunnerNames: string[]): string[] {
  const problems: string[] = [];
  const runners = (doc as { host?: { runners?: { githubNeedsAdmin?: unknown; runners?: unknown } } } | null)?.host?.runners;
  if (runners === undefined) return ['status --json has no .host.runners'];
  if (runners.githubNeedsAdmin !== true) problems.push(`.host.runners.githubNeedsAdmin is ${JSON.stringify(runners.githubNeedsAdmin)}, expected true`);
  if (!Array.isArray(runners.runners)) return [...problems, '.host.runners.runners is not an array'];
  const list = runners.runners as { slot?: unknown; name?: unknown; active?: unknown; listed?: unknown; status?: unknown }[];
  if (list.length !== peerRunnerCount) problems.push(`.host.runners.runners lists ${list.length} Runners, expected the collaborator's ${peerRunnerCount}`);
  list.forEach((r, i) => {
    const at = `.host.runners.runners[${i}] (${String(r.slot)})`;
    if (r.active !== true) problems.push(`${at}.active is ${JSON.stringify(r.active)}, expected true`);
    if (r.listed !== false) problems.push(`${at}.listed is ${JSON.stringify(r.listed)}, expected false`);
    if (r.status !== undefined) problems.push(`${at}.status is ${JSON.stringify(r.status)}, expected none (GitHub's state needs admin)`);
    if (typeof r.name === 'string' && ownerRunnerNames.includes(r.name)) problems.push(`${at} is the Owner's registration ${r.name}`);
  });
  return problems;
}
