import { DELIVERED_REPOS, E2E_REPO, SHAPE_MARKER } from '../host/config.ts';
import type { GitHub } from '../host/github.ts';
import type { MapEntry, RuleId, Scenario } from '../types.ts';
import { readChanges } from './changes.ts';
import type { SourceFile } from './changes.ts';
import { authorityCitations, parseShapeLine } from './citations.ts';
import type { Decision } from './decisions.ts';

export interface IssueRef {
  repo: string;
  number: number;
}

const REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;

/** Parses `<owner/repo>#<n>`; the repository must be one whose delivered Issues select a rerun. */
export function parseIssueRef(text: string): IssueRef | { error: string } {
  const m = REF.exec(text);
  if (!m) return { error: `--delivered ${text}: expected <owner/repo>#<n>` };
  if (!DELIVERED_REPOS.includes(m[1] as string)) {
    return { error: `--delivered ${text}: the repository must be one of ${DELIVERED_REPOS.join(', ')}` };
  }
  return { repo: m[1] as string, number: Number(m[2]) };
}

export type ImpactState =
  'not-delivered' | 'line' | 'none' | 'missing-line' | 'malformed-line' | 'no-shape' | 'multiple-shapes';

export interface ImpactSource {
  issue: string;
  url: string;
  state: ImpactState;
  /** The Shape comment the line came from, when exactly one was found. */
  shape?: string;
  /** The malformed `Proposal rules:` line, quoted. */
  malformed?: string;
  /** Set when the selection fell back to the Issue's `## Authority` citations. */
  fallback?: { ids: RuleId[]; sections: number[] };
  /** For a nibfin-e2e Issue, the merged pull requests whose changed files were read. */
  pulls?: string[];
}

/** What a nibfin-e2e Issue's changed files are matched against. */
export interface ChangeContext {
  scenarios: Scenario[];
  /** The checkout's `scenarios/**` files; read only when a changed file is under `scenarios/`. */
  sources: () => SourceFile[];
}

interface Issue {
  html_url?: string;
  state?: string;
  body?: string | null;
  labels?: (string | { name?: string })[];
  pull_request?: unknown;
}

interface Comment {
  html_url?: string;
  body?: string | null;
  user?: { login?: string } | null;
}

const labelNames = (issue: Issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));

/**
 * The rules a delivered Issue affects: the approved Shape's `Proposal rules:` line, or,
 * without a usable line, the Issue's `## Authority` citations. A nibfin-e2e Issue adds the
 * rules its merged pull requests' changed files affect (`readChanges`). Everything is read
 * from GitHub now, so a stale or repeated dispatch selects from the current state (Proposal R1.11).
 */
export async function readImpact(
  gh: GitHub,
  ref: IssueRef,
  entries: MapEntry[],
  changes?: ChangeContext,
): Promise<{ source: ImpactSource; ids: RuleId[]; decisions: Decision[] }> {
  const name = `${ref.repo}#${ref.number}`;
  const { data: issue } = await gh.rest<Issue>('GET', `/repos/${ref.repo}/issues/${ref.number}`);
  const url = issue.html_url ?? `https://github.com/${ref.repo}/issues/${ref.number}`;
  const decisions: Decision[] = [];
  const delivered = !issue.pull_request && issue.state === 'closed' && labelNames(issue).includes('delivered');
  if (!delivered) {
    const reason = issue.pull_request
      ? 'it is a pull request'
      : `it is ${issue.state ?? 'in an unknown state'} with labels [${labelNames(issue).join(', ')}]`;
    decisions.push({
      subject: name,
      decision: 'not delivered: nothing selected',
      reason: `${reason}; only an Issue closed with \`delivered\` selects a rerun`,
    });
    return { source: { issue: name, url, state: 'not-delivered' }, ids: [], decisions };
  }

  const { data: me } = await gh.rest<{ login?: string }>('GET', '/user');
  const comments = await gh.list<Comment>(`/repos/${ref.repo}/issues/${ref.number}/comments`);
  const shapes = comments.filter((c) => (c.body ?? '').startsWith(SHAPE_MARKER) && c.user?.login === me.login);

  let state: ImpactState;
  let ids: RuleId[] = [];
  const source: ImpactSource = { issue: name, url, state: 'no-shape' };
  if (shapes.length === 1) {
    const shape = shapes[0] as Comment;
    if (shape.html_url) source.shape = shape.html_url;
    const line = parseShapeLine(shape.body ?? '');
    state = line.state;
    if (line.state === 'line') {
      ids = line.ids;
      decisions.push({
        subject: name,
        decision: 'selected from the Shape line',
        reason: `Proposal rules: ${line.ids.join(', ')}`,
      });
    } else if (line.state === 'none') {
      decisions.push({
        subject: name,
        decision: 'nothing selected',
        reason: 'the Shape line is `Proposal rules: none`',
      });
    } else if (line.state === 'malformed-line') {
      source.malformed = line.text;
      decisions.push({
        subject: name,
        decision: 'malformed Shape line',
        reason: `treated like a missing line: ${line.text}`,
      });
    } else {
      decisions.push({
        subject: name,
        decision: 'Shape without a line',
        reason: 'the approved Shape has no `Proposal rules:` line (approved before the format existed)',
      });
    }
  } else {
    state = shapes.length === 0 ? 'no-shape' : 'multiple-shapes';
    decisions.push({
      subject: name,
      decision: shapes.length === 0 ? 'no approved Shape found' : 'more than one approved Shape found',
      reason: `${shapes.length} comments start with ${SHAPE_MARKER} and are by ${me.login ?? 'the token account'}`,
    });
  }
  source.state = state;
  if (state !== 'line' && state !== 'none') {
    const cited = authorityCitations(issue.body ?? '', entries);
    source.fallback = cited;
    ids = cited.ids;
    decisions.push({
      subject: name,
      decision: "fell back to the Issue's ## Authority",
      reason: cited.ids.length
        ? `cited: ${cited.ids.join(', ')}${cited.sections.length ? ` (sections ${cited.sections.map((s) => `§${s}`).join(', ')})` : ''}`
        : 'it cites no rule or section',
    });
  }
  if (ref.repo === E2E_REPO && changes) {
    const changed = await readChanges(gh, ref, changes.scenarios, changes.sources);
    source.pulls = changed.pulls;
    decisions.push(...changed.decisions);
    ids = [...ids];
    for (const id of [...changed.ids, ...(changed.all ? entries.map((e) => e.id) : [])])
      if (!ids.includes(id)) ids.push(id);
  }
  return { source, ids, decisions };
}

interface ListedIssue {
  number?: number;
  closed_at?: string | null;
  pull_request?: unknown;
}

/**
 * Every Issue in the repositories whose delivered Issues select a rerun that is closed with
 * `delivered` at or after `since`, in repository order and then by number. The list's `since`
 * filters by last update, which is never earlier than closing, so it only narrows the
 * candidates; `closed_at` is then compared as a timestamp. `readImpact` rechecks each Issue.
 */
export async function listDeliveredSince(gh: GitHub, since: string): Promise<IssueRef[]> {
  const from = Date.parse(since);
  const out: IssueRef[] = [];
  for (const repo of DELIVERED_REPOS) {
    const issues = await gh.list<ListedIssue>(
      `/repos/${repo}/issues?state=closed&labels=delivered&since=${encodeURIComponent(since)}`,
    );
    const numbers = issues
      .filter((i) => {
        if (i.pull_request || !Number.isInteger(i.number) || (i.number as number) < 1) return false;
        const closed = typeof i.closed_at === 'string' ? Date.parse(i.closed_at) : NaN;
        return !Number.isNaN(closed) && closed >= from;
      })
      .map((i) => i.number as number);
    for (const number of [...new Set(numbers)].sort((a, b) => a - b)) out.push({ repo, number });
  }
  return out;
}
