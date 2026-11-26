import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Scenario } from '../../src/types.ts';
import { Check, tail } from '../lib/check.ts';
import { parseHelp } from '../lib/gh.ts';
import { nibfinFacts, openPulls, putFile, readFile, registrations, whoami } from '../lib/github.ts';
import { HOLD_PATH, finishHold, removeHold, startHold } from '../lib/hold.ts';
import type { Hold } from '../lib/hold.ts';
import { requireCurrentImage } from '../lib/image.ts';
import { waitFor } from '../lib/wait.ts';

const ISSUE_WF = '.github/workflows/nibfin-issue.yml';

/** Each claude Runner's `.env` (Proposal R4.18, R5.40): `${XDG_DATA_HOME:-~/.local/share}/nibfin/runners/claude-<n>/.env`. */
export function runnerEnvFiles(dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')): string[] {
  const dir = join(dataHome, 'nibfin', 'runners');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^claude-\d+$/.test(d))
    .map((d) => join(dir, d, '.env'))
    .filter((f) => existsSync(f))
    .sort();
}

export const withoutProvider = (text: string) => text.split('\n').filter((l) => !/^NIBFIN_PROVIDER=/.test(l)).join('\n');

/** Top-level keys whose values differ; the values themselves hold the token and are never shown. */
export function changedKeys(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => !isDeepStrictEqual(a?.[k], b?.[k])).sort();
}

export const upgrade: Scenario = {
  id: 'upgrade',
  rules: ['R5.1', 'R5.38', 'R5.39', 'R5.40', 'R5.54', 'R6.22'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const gh = ctx.github;
    const repo = ctx.sandbox.execution;
    const { imageDigest } = nibfinFacts(ctx);
    const me = await whoami(gh);

    const help = parseHelp((await ctx.ghNibfin(['upgrade', '--help'])).stdout);
    const odd = help.flags.filter((f) => /version|tag|digest|all/i.test(f.name)).map((f) => f.name);
    c.that(!odd.length, 'R5.39', `upgrade --help offers ${odd.map((f) => `--${f}`).join(', ')}`);

    const pulls = async () => (await openPulls(gh, repo)).map((p) => p.number);
    const upgradeOnce = async (rule: string) => {
      const pre = await requireCurrentImage(imageDigest);
      if (pre) return pre;
      const r = await ctx.ghNibfin(['upgrade', '--yes']);
      c.that(r.code === 0, rule, `upgrade --yes exited ${r.code}: ${tail(r)}`);
      return undefined;
    };

    const settingsBefore = await ctx.claudeSettings();
    const envs = runnerEnvFiles();
    if (envs.length !== 2) return { status: 'failed', reason: `precondition not reached: found ${envs.length} claude Runner .env files, expected 2` };
    const originals = new Map(envs.map((f) => [f, readFileSync(f, 'utf8')]));
    for (const [f, text] of originals) writeFileSync(f, withoutProvider(text));

    let hold: Hold | undefined;
    let holdFile = true;
    try {
      hold = await startHold(gh, repo, 120);
      const before = await pulls();
      const pre = await upgradeOnce('R5.40');
      if (pre) return pre;
      const opened = (await pulls()).filter((n) => !before.includes(n));
      c.that(!opened.length, 'R5.38', `upgrade on a current repository opened PR ${opened.map((n) => `#${n}`).join(', ')}`);
      const conclusion = await finishHold(gh, repo, hold);
      c.that(conclusion === 'success', 'R5.40', `the Job on the busy Runner ${hold.runnerName} ended ${conclusion}; upgrade must not restart a Runner mid-Job`);
      for (const f of envs) c.that(/^NIBFIN_PROVIDER=claude$/m.test(readFileSync(f, 'utf8')), 'R5.40', `${f} has no NIBFIN_PROVIDER=claude after upgrade`);
      await c.part('R5.40', async () => {
        await waitFor(() => registrations(gh, repo), (rs) => rs.length === 2 && rs.every((r) => r.status === 'online' && r.labels.some((l) => l.name === `nibfin-${me.id}`)), {
          what: `both Runners online with nibfin-${me.id} after upgrade`,
          deadlineMs: 2 * 60_000,
          intervalMs: 10_000,
        });
      });
      const settingsAfter = await ctx.claudeSettings();
      const changed = changedKeys(settingsBefore, settingsAfter);
      c.that(!changed.length, 'R6.22', `upgrade changed the login volume's settings.json keys ${changed.join(', ')}`);

      // R5.1: a workflow GitHub still lists after its file was deleted must not fail upgrade.
      await removeHold(gh, repo);
      holdFile = false;
      const listed = await gh.list<{ path: string; state: string }>(`/repos/${repo}/actions/workflows`, 'workflows');
      if (!listed.some((w) => w.path === HOLD_PATH)) return { status: 'failed', reason: `precondition not reached: GitHub no longer lists the deleted ${HOLD_PATH}` };

      const file = await readFile(gh, repo, ISSUE_WF);
      if (!file) return { status: 'failed', reason: `precondition not reached: ${repo} has no ${ISSUE_WF} on main` };
      await putFile(gh, repo, ISSUE_WF, `${file.text.replace(/\n?$/, '\n')}# nibfin-e2e: local change\n`, 'nibfin-e2e: change nibfin-issue.yml');
      const before2 = await pulls();
      const pre2 = await upgradeOnce('R5.1');
      if (pre2) return pre2;
      const opened2 = (await pulls()).filter((n) => !before2.includes(n));
      if (c.that(opened2.length === 1, 'R5.38', `upgrade on an outdated nibfin-issue.yml opened ${opened2.length} PRs, expected 1`) && opened2[0] !== undefined) {
        const n = opened2[0];
        const files = await gh.list<{ filename: string }>(`/repos/${repo}/pulls/${n}/files`);
        c.that(files.some((f) => f.filename === ISSUE_WF), 'R5.38', `upgrade PR #${n} does not touch ${ISSUE_WF}`);
        const { data: pr } = await gh.rest<{ merged_at: string | null; state: string; head: { sha: string } }>('GET', `/repos/${repo}/pulls/${n}`);
        c.that(pr.state === 'open' && pr.merged_at === null, 'R5.54', `upgrade PR #${n} is ${pr.state}${pr.merged_at ? ', merged' : ''}; the user decides to merge it`);
        await gh.rest('PUT', `/repos/${repo}/pulls/${n}/merge`, { merge_method: 'rebase', sha: pr.head.sha });
        const before3 = await pulls();
        const pre3 = await upgradeOnce('R5.38');
        if (pre3) return pre3;
        const opened3 = (await pulls()).filter((x) => !before3.includes(x));
        c.that(!opened3.length, 'R5.38', `upgrade right after merging its PR opened ${opened3.map((x) => `#${x}`).join(', ')}`);
      }
    } finally {
      if (holdFile) await removeHold(gh, repo);
      // When upgrade never ran, put back the provider line this scenario removed.
      for (const [f, text] of originals) if (!/^NIBFIN_PROVIDER=/m.test(readFileSync(f, 'utf8'))) writeFileSync(f, text);
    }
    return c.outcome('upgrade opened no PR when current and exactly one when nibfin-issue.yml was outdated, aligned the Runners only when idle, and kept the login settings');
  },
};
