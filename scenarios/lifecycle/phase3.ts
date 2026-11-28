// Phase 3: the credential scan, after everything else has written what it writes.
import { throwIfAborted, untilAborted } from '../../src/abort.ts';
import { GitHubError, GitHubNoResponse } from '../../src/host/github.ts';
import type { Outcome, Scenario } from '../../src/types.ts';
import { sleep } from '../lib/wait.ts';
import { ranOnRunner } from './analysis.ts';
import type { Job, LogLine } from './analysis.ts';
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

/** How long a job's log that cannot be read yet is read again before it counts as unreadable. */
export const LOG_READ_BOUND_MS = 120_000;
/** The pause between two reads of a job's log that could not be read. */
export const LOG_READ_INTERVAL_MS = 15_000;

/** A job's log that stayed unreadable: the last read's error, how many reads ran and when. */
interface UnreadLog {
  error: unknown;
  reads: number;
  firstAt: number;
  lastAt: number;
}

/**
 * Reads a job's log. GitHub may not serve the log of a job that has just completed, so a
 * failed read is repeated, pausing `LOG_READ_INTERVAL_MS` between reads, until
 * `LOG_READ_BOUND_MS` after the first read. The Observer does not keep a failed read, so
 * each read is a new download. When every read fails it gives the last read's error with
 * the read count and the start times of the first and last read. An aborted run ends the
 * wait with the abort reason instead of waiting out the bound.
 */
async function readLog(k: Kit, repo: string, job: Job): Promise<{ lines: LogLine[] } | UnreadLog> {
  const firstAt = k.now();
  for (let reads = 1; ; reads++) {
    const lastAt = k.now();
    try {
      return { lines: await k.obs.log(repo, job.id) };
    } catch (error) {
      throwIfAborted(k.ctx.signal);
      const left = LOG_READ_BOUND_MS - (k.now() - firstAt);
      if (left <= 0) return { error, reads, firstAt, lastAt };
      await untilAborted((k.sleep ?? sleep)(Math.min(LOG_READ_INTERVAL_MS, left)), k.ctx.signal);
    }
  }
}

/**
 * The last status of a failed log read and where it came from: the API host's response
 * or the redirected download step. `GitHub.download` names the redirected step in fixed
 * message text and never puts the signed URL there, so that text is matched here.
 */
export function describeReadError(e: unknown): string {
  if (e instanceof GitHubError) {
    const from = e.message.endsWith('the redirected download failed') ? 'the redirected download' : 'the API host';
    return `last status ${e.status} from ${from}`;
  }
  if (e instanceof GitHubNoResponse) {
    const redirected = e.message.includes('the redirected download got no response');
    return `no response from ${redirected ? 'the redirected download' : 'the API host'}`;
  }
  return 'no HTTP status';
}

/** An unreadable log's detail: the original error, the job's completion, the reads, the last status and the next step. */
function unreadDetail(job: Job, log: UnreadLog): string {
  const iso = (t: number) => new Date(t).toISOString();
  const seconds = Math.round((log.lastAt - log.firstAt) / 1000);
  return (
    `${message(log.error)}; completed_at ${job.completed_at ?? 'unknown'}; ` +
    `read ${log.reads} times from ${iso(log.firstAt)} to ${iso(log.lastAt)} over about ${seconds} s; ` +
    `${describeReadError(log.error)}; next: check whether GitHub stores this job's log at all ` +
    `(GET the job's logs endpoint), since the check stays failed until it can be read`
  );
}

/**
 * Scans every text a run leaves on GitHub. Leaks are reported by location only. A job no
 * runner took has no log and is skipped. The log of a job that ran is read again for a
 * bounded time while it cannot be read; one that stays unreadable is listed apart from
 * the leaks, with its error, the job's completion time, the reads and the last status.
 */
export async function scan(k: Kit): Promise<ScanResult> {
  const secrets = k.ctx.secretValues();
  const found: string[] = [];
  const unreadable: string[] = [];
  const s = await k.obs.fresh();
  for (const repo of [k.exec, k.peer]) {
    const r = `/repos/${repo}`;
    for (const i of await k.gh.list<{ number: number; title: string; body: string | null }>(`${r}/issues?state=all`)) {
      found.push(
        ...leaks(`${repo}#${i.number} title`, i.title, secrets),
        ...leaks(`${repo}#${i.number} body`, i.body, secrets),
      );
    }
    for (const cm of await k.gh.list<{ html_url: string; body?: string }>(`${r}/issues/comments`))
      found.push(...leaks(cm.html_url, cm.body, secrets));
    for (const cm of await k.gh.list<{ html_url: string; body?: string }>(`${r}/pulls/comments`))
      found.push(...leaks(cm.html_url, cm.body, secrets));
    for (const pr of s.pulls.get(repo) ?? []) {
      for (const f of await k.gh.list<{ filename: string; patch?: string }>(`${r}/pulls/${pr.number}/files`))
        found.push(...leaks(`${repo} PR #${pr.number} ${f.filename}`, f.patch, secrets));
    }
    for (const run of s.runs.filter((x) => x.repo === repo && x.display_title.startsWith('Nibfin ·'))) {
      for (const job of await k.obs.jobs(repo, run.id)) {
        if (job.status !== 'completed' || !ranOnRunner(job)) continue;
        const log = await readLog(k, repo, job);
        if ('error' in log) {
          unreadable.push(`${repo} job ${job.id} (${run.display_title}): ${unreadDetail(job, log)}`);
          continue;
        }
        found.push(
          ...leaks(
            `${repo} job ${job.id} log (${run.display_title})`,
            log.lines.map((l) => l.text).join('\n'),
            secrets,
          ),
        );
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
  if (unreadable.length)
    parts.push(
      `these Nibfin job logs could not be checked, so the absence of credentials in them is not shown: ${unreadable.join('; ')}`,
    );
  if (parts.length) return { status: 'failed', reason: `R3.49: ${parts.join('. Separately, ')}${note}` };
  return {
    status: 'passed',
    reason: `no secret value or token-shaped string in Issues, PRs, comments, patches or Nibfin job logs of either sandbox${note}`,
  };
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
