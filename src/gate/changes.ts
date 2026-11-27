import { posix } from 'node:path';
import type { GitHub } from '../host/github.ts';
import type { RuleId, Scenario } from '../types.ts';
import type { Decision } from './decisions.ts';
import type { IssueRef } from './impact.ts';

/** A file of the gate's own checkout, by repository path (`scenarios/lib/kit.ts`). */
export interface SourceFile {
  path: string;
  text: string;
}

/** What a changed path means for the rerun. */
export type PathKind = 'scenario' | 'harness' | 'other';

/**
 * `scenarios/**` changes the scenarios defined in or importing the file; `src/**` outside
 * `src/gate/**` (harness and provisioning, `src/host/*` included) and `sandbox-template/**`
 * can change every scenario; anything else (docs, tests, gate code, relay, config) changes none.
 */
export function classifyPath(path: string): PathKind {
  if (path.startsWith('scenarios/')) return 'scenario';
  if (path.startsWith('src/gate/')) return 'other';
  if (path.startsWith('src/') || path.startsWith('sandbox-template/')) return 'harness';
  return 'other';
}

/** GitHub lists at most this many files of one pull request. */
export const MAX_PR_FILES = 3000;

const IMPORT = [/\bfrom\s*['"](\.{1,2}\/[^'"\n]+)['"]/g, /\bimport\s*\(?\s*['"](\.{1,2}\/[^'"\n]+)['"]/g];
/** A scenario id as written where it is defined: `id: '<id>'` or a factory's first argument `make('<id>'`. */
const ID = /(?:\bid\s*:\s*|\b[A-Za-z_$][\w$]*\s*\(\s*)['"]([^'"\n]+)['"]/g;

export interface ScenarioIndex {
  /** Registry scenario ids each file defines. */
  defines: Map<string, string[]>;
  /** For each file, the files under `scenarios/` that import it directly. */
  importers: Map<string, Set<string>>;
}

/** Maps the checkout's scenario files to the registry ids they define and to their relative imports. */
export function indexScenarios(sources: SourceFile[], ids: Iterable<string>): ScenarioIndex {
  const known = new Set(ids);
  const paths = new Set(sources.map((s) => s.path));
  const resolve = (from: string, spec: string): string | undefined => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) if (paths.has(candidate)) return candidate;
    return base.startsWith('scenarios/') ? base : undefined;
  };
  const defines = new Map<string, string[]>();
  const importers = new Map<string, Set<string>>();
  for (const { path, text } of sources) {
    const found: string[] = [];
    for (const m of text.matchAll(ID)) {
      const id = m[1] as string;
      if (known.has(id) && !found.includes(id)) found.push(id);
    }
    if (found.length) defines.set(path, found);
    for (const re of IMPORT) {
      for (const m of text.matchAll(re)) {
        const target = resolve(path, m[1] as string);
        if (!target || !target.startsWith('scenarios/')) continue;
        const set = importers.get(target) ?? new Set<string>();
        set.add(path);
        importers.set(target, set);
      }
    }
  }
  return { defines, importers };
}

/** The registry ids defined in `path` or in any file that imports it, transitively. */
export function affectedScenarios(index: ScenarioIndex, path: string): string[] {
  const seen = new Set<string>([path]);
  const queue = [path];
  while (queue.length) {
    const next = queue.shift() as string;
    for (const importer of index.importers.get(next) ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  const out: string[] = [];
  for (const file of [...seen].sort()) for (const id of index.defines.get(file) ?? []) if (!out.includes(id)) out.push(id);
  return out;
}

interface Pull {
  number?: number;
  html_url?: string;
  merged_at?: string | null;
  base?: { ref?: string; repo?: { default_branch?: string } | null } | null;
}

interface PullFile {
  filename?: string;
  previous_filename?: string;
}

export interface ChangeImpact {
  /** The merged pull requests read, by URL. */
  pulls: string[];
  /** Rules of the scenarios the changed `scenarios/**` files affect. */
  ids: RuleId[];
  /** Set when a change can affect every scenario: every map rule is selected. */
  all: boolean;
  decisions: Decision[];
}

/**
 * The rules an e2e Issue's merged pull requests affect, from the files they changed. The
 * pull requests are the ones from the Issue's delivery branch `nibfin/issue-<n>` (Proposal
 * R3.16) and its CD fix branches `nibfin/issue-<n>-cd-<k>`, merged into the default branch.
 */
export async function readChanges(gh: GitHub, ref: IssueRef, scenarios: Scenario[], sources: () => SourceFile[]): Promise<ChangeImpact> {
  const name = `${ref.repo}#${ref.number}`;
  const owner = ref.repo.split('/')[0] as string;
  const branch = `nibfin/issue-${ref.number}`;
  const decisions: Decision[] = [];
  const byBranch = (head: string) => gh.list<Pull>(`/repos/${ref.repo}/pulls?state=closed&head=${owner}:${head}`);

  const pulls: Pull[] = [...(await byBranch(branch))];
  for (let k = 1; ; k++) {
    const found = await byBranch(`${branch}-cd-${k}`);
    if (!found.length) break;
    pulls.push(...found);
  }
  const merged = pulls.filter((p) => p.merged_at && p.base?.ref !== undefined && p.base.ref === p.base.repo?.default_branch);
  const urls = merged.map((p) => p.html_url ?? `https://github.com/${ref.repo}/pull/${p.number}`);
  if (!merged.length) {
    decisions.push({ subject: name, decision: 'no change selected', reason: `no merged PR on ${branch}: only the Shape line or Authority selects` });
    return { pulls: [], ids: [], all: false, decisions };
  }

  const harness: string[] = [];
  const scenarioPaths: string[] = [];
  const other: string[] = [];
  const truncated: string[] = [];
  for (const [i, pull] of merged.entries()) {
    const files = await gh.list<PullFile>(`/repos/${ref.repo}/pulls/${pull.number}/files`);
    if (files.length >= MAX_PR_FILES) truncated.push(urls[i] as string);
    for (const f of files) {
      for (const path of [f.filename, f.previous_filename]) {
        if (!path) continue;
        const bucket = { scenario: scenarioPaths, harness, other }[classifyPath(path)];
        if (!bucket.includes(path)) bucket.push(path);
      }
    }
  }
  decisions.push({ subject: name, decision: 'read merged PR files', reason: urls.join(', ') });

  const all = harness.length > 0 || truncated.length > 0;
  if (truncated.length) {
    decisions.push({ subject: name, decision: 'selected every rule', reason: `${truncated.join(', ')} lists ${MAX_PR_FILES} files, so the list may be truncated` });
  }
  if (harness.length) {
    decisions.push({ subject: name, decision: 'selected every rule', reason: `harness, provisioning or sandbox template changed: ${harness.join(', ')}` });
  }

  const ids: RuleId[] = [];
  if (scenarioPaths.length) {
    const index = indexScenarios(sources(), scenarios.map((s) => s.id));
    const byId = new Map(scenarios.map((s) => [s.id, s]));
    for (const path of scenarioPaths) {
      const affected = affectedScenarios(index, path);
      const rules: RuleId[] = [];
      for (const id of affected) for (const rule of byId.get(id)?.rules ?? []) if (!rules.includes(rule)) rules.push(rule);
      for (const rule of rules) if (!ids.includes(rule)) ids.push(rule);
      decisions.push(
        affected.length
          ? { subject: path, decision: 'selected from the changed scenario file', reason: `scenarios: ${affected.join(', ')}; rules: ${rules.join(', ') || 'none'}` }
          : { subject: path, decision: 'no scenario selected', reason: 'the file defines no registry scenario and no file that does imports it' },
      );
    }
  }
  if (other.length) {
    decisions.push({ subject: name, decision: 'nothing selected from these files', reason: `only docs, tests, gate code or configuration: ${other.join(', ')}` });
  }
  if (!all && !ids.length) {
    decisions.push({ subject: name, decision: 'no change selected', reason: 'the merged PRs changed no harness, provisioning, sandbox template or scenario file that defines a scenario' });
  }
  return { pulls: urls, ids, all, decisions };
}
