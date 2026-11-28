import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario } from '../../src/types.ts';
import { Check, tail } from '../lib/check.ts';
import { nibfinFacts } from '../lib/github.ts';
import { requireCurrentImage } from '../lib/image.ts';

export const imageDigest: Scenario = {
  id: 'image-digest',
  rules: ['R8.7'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const { imageDigest: digest } = nibfinFacts(ctx);
    // No image release record exists yet, so init must use the newest signed main image.
    const moved = await requireCurrentImage(digest);
    const v = await ctx.gh([
      'attestation',
      'verify',
      `oci://ghcr.io/taco3064/nibfin@${digest}`,
      '--repo',
      'taco3064/nibfin-core',
    ]);
    c.that(
      v.code === 0,
      'R8.7',
      `gh attestation verify of ghcr.io/taco3064/nibfin@${digest} exited ${v.code}: ${tail(v, 400)}`,
    );
    // A newer main image after init makes a different digest correct: report the precondition, not a product mismatch.
    if (moved) return { status: 'failed', reason: [moved.reason, ...c.problems].join('; ') };
    return c.outcome(
      `init pinned ${digest}, the current GHCR :main digest, and its attestation verifies against nibfin-core`,
    );
  },
};

/** Files named gh-nibfin (an installed extension binary) anywhere under `dir`. */
function installedBinaries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory() && /^gh-nibfin(\.exe)?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

/** Lines of gh-nibfin's CI that would publish a Release. */
export function releaseSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter(
      (l) =>
        /\bgh\s+release\b|action-gh-release|goreleaser/i.test(l) ||
        /\/releases(?!\/download\/)(?!\/latest\/download\/)\b/.test(l),
    )
    .map((l) => l.trim());
}

export const extensionReleases: Scenario = {
  id: 'extension-releases',
  rules: ['R8.9'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const home = ctx.workPath('ext-home');
    rmSync(home, { recursive: true, force: true });
    // gh keeps extensions under $XDG_DATA_HOME/gh; this never touches the local install.
    const env = { XDG_DATA_HOME: home };
    const list = async () => {
      const r = await ctx.gh(['extension', 'list'], { env });
      if (r.code !== 0) throw new Error(`gh extension list exited ${r.code}: ${tail(r, 200)}`);
      return r.stdout;
    };
    if (/\bnibfin\b/.test(await list())) {
      return {
        status: 'failed',
        reason:
          'precondition not reached: the isolated gh extension directory already lists nibfin, so XDG_DATA_HOME did not isolate it',
      };
    }
    const latest = await ctx.github.rest<{ tag_name?: string }>(
      'GET',
      '/repos/taco3064/gh-nibfin/releases/latest',
      undefined,
      [404],
    );
    if (latest.status === 404) {
      const r = await ctx.gh(['extension', 'install', 'taco3064/gh-nibfin'], { env });
      c.that(
        r.code !== 0,
        'R8.9',
        `gh extension install taco3064/gh-nibfin succeeded although gh-nibfin has no Release: ${tail(r, 300)}`,
      );
      c.that(
        !/\bnibfin\b/.test(await list()),
        'R8.9',
        'gh extension list shows nibfin after an install without a Release',
      );
      const bins = installedBinaries(home);
      c.that(!bins.length, 'R8.9', `an install without a Release left ${bins.join(', ')}`);
    } else {
      const tag = String(latest.data.tag_name);
      const r = await ctx.gh(['extension', 'install', 'taco3064/gh-nibfin'], { env });
      c.that(r.code === 0, 'R8.9', `gh extension install taco3064/gh-nibfin exited ${r.code}: ${tail(r, 300)}`);
      c.that((await list()).includes(tag), 'R8.9', `gh extension list does not show the latest Release ${tag}`);
      const u = await ctx.gh(['extension', 'upgrade', 'nibfin'], { env });
      c.that(
        u.code === 0 && (await list()).includes(tag),
        'R8.9',
        `gh extension upgrade nibfin left ${tag} (exit ${u.code}: ${tail(u, 200)})`,
      );
    }
    const wf = ctx.workPath('gh-nibfin', '.github', 'workflows');
    const files = existsSync(wf) ? readdirSync(wf).filter((f) => /\.ya?ml$/.test(f)) : [];
    c.that(files.length > 0, 'R8.9', `the gh-nibfin clone has no CI workflows under .github/workflows`);
    for (const f of files) {
      const hits = releaseSteps(readFileSync(join(wf, f), 'utf8'));
      c.that(!hits.length, 'R8.9', `gh-nibfin CI ${f} publishes Releases: ${hits.slice(0, 3).join(' | ')}`);
    }
    const how =
      latest.status === 404
        ? 'without a Release gh extension install fails and installs nothing'
        : 'install and upgrade use the latest Release';
    return c.outcome(`${how}; gh-nibfin CI (${files.join(', ')}) does not publish Releases`);
  },
};
