// Phase 3: the credential scan, after everything else has written what it writes.
import type { Outcome, Scenario } from '../../src/types.ts';
import { ranOnRunner } from './analysis.ts';
import type { LogLine } from './analysis.ts';
import { journey } from './journeys.ts';
import { lifecycle, message } from './kit.ts';
import type { Kit } from './kit.ts';

/** Token shapes that must never appear, whatever the value. */
export const TOKEN_SHAPES = /github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9]{30,}|sk-ant-[A-Za-z0-9_-]{20,}/;

/** Where a text holds a secret value or a token-shaped string; never the value itself. */
export function leaks(location: string, text: string | null | undefined, secrets: string[]): string[] {
  if (!text) return [];
  const out: string[] = [];
  if (secrets.some((s) => s && text.includes(s))) out.push(`${location}: a secret value`);
  if (TOKEN_SHAPES.test(text)) out.push(`${location}: a token-shaped string`);
  return out;
}

/** What the scan saw: leak locations (never values) and Nibfin job logs it could not read. */
export interface ScanResult {
  found: string[];
  unreadable: string[];
}

/**
 * Reads a job's log, reading it once more right away when the first read fails (the
 * Observer does not keep a failed read, so the second is a new download). Gives the
 * error of the second read when both fail.
 */
async function readLog(k: Kit, repo: string, jobId: number): Promise<{ lines: LogLine[] } | { error: unknown }> {
  try {
    return { lines: await k.obs.log(repo, jobId) };
  } catch {
    try {
      return { lines: await k.obs.log(repo, jobId) };
    } catch (e) {
      return { error: e };
    }
  }
}

/**
 * Scans every text a run leaves on GitHub. Leaks are reported by location only. A job no
 * runner took has no log and is skipped; the log of a job that ran but stayed unreadable
 * is listed apart from the leaks, with its error.
 */
export async function scan(k: Kit): Promise<ScanResult> {
  const secrets = k.ctx.secretValues();
  const found: string[] = [];
  const unreadable: string[] = [];
  const s = await k.obs.fresh();
  for (const repo of [k.exec, k.peer]) {
    const r = `/repos/${repo}`;
    for (const i of await k.gh.list<{ number: number; title: string; body: string | null }>(`${r}/issues?state=all`)) {
      found.push(...leaks(`${repo}#${i.number} title`, i.title, secrets), ...leaks(`${repo}#${i.number} body`, i.body, secrets));
    }
    for (const cm of await k.gh.list<{ html_url: string; body?: string }>(`${r}/issues/comments`)) found.push(...leaks(cm.html_url, cm.body, secrets));
    for (const cm of await k.gh.list<{ html_url: string; body?: string }>(`${r}/pulls/comments`)) found.push(...leaks(cm.html_url, cm.body, secrets));
    for (const pr of s.pulls.get(repo) ?? []) {
      for (const f of await k.gh.list<{ filename: string; patch?: string }>(`${r}/pulls/${pr.number}/files`)) found.push(...leaks(`${repo} PR #${pr.number} ${f.filename}`, f.patch, secrets));
    }
    for (const run of s.runs.filter((x) => x.repo === repo && x.display_title.startsWith('Nibfin ·'))) {
      for (const job of await k.obs.jobs(repo, run.id)) {
        if (job.status !== 'completed' || !ranOnRunner(job)) continue;
        const log = await readLog(k, repo, job.id);
        if ('error' in log) {
          unreadable.push(`${repo} job ${job.id} (${run.display_title}): ${message(log.error)}`);
          continue;
        }
        found.push(...leaks(`${repo} job ${job.id} log (${run.display_title})`, log.lines.map((l) => l.text).join('\n'), secrets));
      }
    }
  }
  return { found, unreadable };
}

/**
 * The R3.49 verdict of a scan. Leaks fail it, by location. Logs of jobs that ran but
 * could not be read fail it too, since the absence of credentials is not shown there,
 * without claiming a leak. `lifecycle()` still redacts the reason.
 */
export function credentialOutcome({ found, unreadable }: ScanResult, note = ''): Outcome {
  const parts: string[] = [];
  if (found.length) parts.push(`credentials found at ${found.join('; ')}`);
  if (unreadable.length) parts.push(`these Nibfin job logs could not be checked, so the absence of credentials in them is not shown: ${unreadable.join('; ')}`);
  if (parts.length) return { status: 'failed', reason: `R3.49: ${parts.join('. Separately, ')}${note}` };
  return { status: 'passed', reason: `no secret value or token-shaped string in Issues, PRs, comments, patches or Nibfin job logs of either sandbox${note}` };
}

export const noCredentials: Scenario = lifecycle({
  id: 'no-credentials',
  rules: ['R3.49'],
  async run(k) {
    let note = '';
    await journey(k).catch((e: unknown) => (note = ` (the shared journey failed: ${message(e)})`));
    return credentialOutcome(await scan(k), note);
  },
});
