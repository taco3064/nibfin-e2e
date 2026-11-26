import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freeOfSecrets } from './checks.ts';
import type { Kit } from './kit.ts';
import { runnerSlot } from './runners.ts';
import { DEADLINE, remoteWait } from './waits.ts';

export interface StageJob {
  id: number;
  name: string;
  runnerName: string;
  /** The Runner slot (`claude-<n>`), from the registration name. */
  slot: string;
  status: string;
}

interface ApiJob {
  id: number;
  name: string;
  runner_name: string | null;
  status: string;
}

/**
 * The stage Job of a run: the one that ran on one of this host's Runners (route and
 * finish Jobs of a public execution repository run on GitHub-hosted runners).
 */
export async function stageJob(kit: Kit, runRepo: string, runId: string): Promise<StageJob> {
  const jobs = await kit.github.list<ApiJob>(`/repos/${runRepo}/actions/runs/${encodeURIComponent(runId)}/jobs`, 'jobs');
  const local = jobs.filter((j) => j.runner_name && runnerSlot(j.runner_name));
  const [job] = local;
  if (local.length !== 1 || !job) {
    const seen = jobs.map((j) => `${j.name} on ${j.runner_name ?? 'no runner'}`).join(', ') || 'none';
    throw new Error(`${runRepo} run ${runId}: expected one Job on a local Runner (a registration ending in -claude-<n>); saw ${seen}`);
  }
  return { id: job.id, name: job.name, runnerName: job.runner_name as string, slot: runnerSlot(job.runner_name as string) as string, status: job.status };
}

/**
 * The stage Job's log, once the Job completed (its post steps finish shortly after the
 * container died), saved under `.e2e-work/logs/`. The text is checked for secret values
 * first: the saved copy never holds one (each is replaced), and `secretFound` says so.
 */
export async function jobLog(kit: Kit, runRepo: string, runId: string, file: string): Promise<{ job: StageJob; text: string; secretFound: boolean }> {
  const job = await remoteWait(kit, `the stage Job of run ${runId} to complete`, DEADLINE.jobLog, 10_000, async () => {
    const j = await stageJob(kit, runRepo, runId);
    return j.status === 'completed' ? j : undefined;
  });
  const { text } = await kit.github.download(`/repos/${runRepo}/actions/jobs/${job.id}/logs`);
  const dir = join(kit.workDir, 'logs');
  mkdirSync(dir, { recursive: true });
  const secrets = kit.secrets();
  const secretFound = !freeOfSecrets(text, secrets);
  const saved = secretFound ? secrets.reduce((t, s) => (s.length < 8 ? t : t.split(s).join('[secret value removed by nibfin-e2e]')), text) : text;
  writeFileSync(join(dir, `${file}.log`), saved);
  return { job, text, secretFound };
}

export interface InitEvent {
  model: string;
  mcpServers: { name: string; status: string }[];
}

/** The Claude CLI's `stream-json` `system`/`init` events kept in a Job log (Proposal R1.14). */
export function initEvents(log: string): InitEvent[] {
  const out: InitEvent[] = [];
  for (const line of log.split('\n')) {
    const i = line.indexOf('{');
    if (i < 0 || !line.includes('"init"')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line.slice(i)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== 'system' || e.subtype !== 'init') continue;
    const servers = Array.isArray(e.mcp_servers) ? (e.mcp_servers as Record<string, unknown>[]) : [];
    out.push({ model: String(e.model ?? ''), mcpServers: servers.map((s) => ({ name: String(s.name ?? ''), status: String(s.status ?? '') })) });
  }
  return out;
}

/** The image reference the generated workflow prints (`Nibfin image: <ref>`). */
export function imageLine(log: string): string | undefined {
  return /Nibfin image: (\S+)/.exec(log)?.[1];
}

/** Output an image build would print; the host must never build (Proposal R8.2). */
export function buildOutput(log: string): string | undefined {
  return /STEP \d+\/\d+|podman build|docker build|buildah bud/.exec(log)?.[0];
}

/** Upper-snake cause codes such as `TOOL_INSTALL_FAILED`. */
export function causeCodes(text: string): string[] {
  return [...new Set(text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
}
