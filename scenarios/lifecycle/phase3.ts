// Phase 3: the credential scan, after everything else has written what it writes.
import type { Scenario } from '../../src/types.ts';
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

/** Scans every text a run leaves on GitHub; returns locations only. */
export async function scan(k: Kit): Promise<string[]> {
  const secrets = k.ctx.secretValues();
  const found: string[] = [];
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
        if (job.status !== 'completed') continue;
        const lines = await k.obs.log(repo, job.id).catch((e: unknown) => {
          found.push(`${repo} job ${job.id}: log unreadable (${message(e)})`);
          return [];
        });
        found.push(...leaks(`${repo} job ${job.id} log (${run.display_title})`, lines.map((l) => l.text).join('\n'), secrets));
      }
    }
  }
  return found;
}

export const noCredentials: Scenario = lifecycle({
  id: 'no-credentials',
  rules: ['R3.49'],
  async run(k) {
    let note = '';
    await journey(k).catch((e: unknown) => (note = ` (the shared journey failed: ${message(e)})`));
    const found = await scan(k);
    if (found.length) return { status: 'failed', reason: `R3.49: credentials found at ${found.join('; ')}${note}` };
    return { status: 'passed', reason: `no secret value or token-shaped string in Issues, PRs, comments, patches or Nibfin job logs of either sandbox${note}` };
  },
});
