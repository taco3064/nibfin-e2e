// The resolution stage corrects an Issue's specification and changes no code (Proposal
// R4.44, R4.48). A `scope` fixture names a misspelled file path that the Issue makes clear;
// Nibfin should stop with `pending`, and the resolution stage should edit the body, write
// what it changed in its record (R4.49), then remove `pending`. Between `pending` and its
// removal no branch, protected path (R3.46) or repository setting may change. `waiting`
// until the stage is delivered (R8.20). Not concurrent: harness scenarios write to `main`,
// protected paths included, and no trusted public field tells their pushes from Nibfin's.
import type { Outcome } from '../../src/types.ts';
import { rulesets } from '../../src/host/sandbox.ts';
import { CI_RULESET, withRulesetLifted } from '../lib/hold.ts';
import { briefRecord, pendingAddedAt, resolutionGate, resolutionRecord } from '../lib/resolution.ts';
import type { ResolutionRecord } from '../lib/resolution.ts';
import { BRANCH_WRITES, Checks, isIssueBranch, markerOf, time } from './analysis.ts';
import type { Activity, Comment, Issue } from './analysis.ts';
import { DEADLINE, PUBLISH_GRACE, lifecycle, message } from './kit.ts';
import type { Kit } from './kit.ts';
import { SHAPE_MARKER } from './marks.ts';

const iso = (t: number) => new Date(t).toISOString();

export interface SpecFixTimes {
  pendingAt: number;
  /** Body edit times (GraphQL `userContentEdits.editedAt`). */
  edits: number[];
  /** `blocked_by_added` timeline event times. */
  blockedByAdded: number[];
  /** The resolution record's last write. */
  recordAt?: number;
  /** The first `unlabeled pending` at or after `pendingAt`. */
  unpendedAt?: number;
}

/** R4.44 problems of the order: a correction after `pending`, then the record, then `pending` removed. */
export function specFixOrder(t: SpecFixTimes): string[] {
  const out: string[] = [];
  const corrections = [...t.edits, ...t.blockedByAdded].filter((x) => x >= t.pendingAt).sort((a, b) => a - b);
  const first = corrections[0];
  if (first === undefined) out.push(`no body edit or Blocked by was added at or after pending was added at ${iso(t.pendingAt)}`);
  if (t.recordAt === undefined) out.push(`no resolution record was written at or after ${iso(t.pendingAt)}`);
  if (t.unpendedAt === undefined) out.push(`pending, added at ${iso(t.pendingAt)}, was not removed`);
  if (first !== undefined && t.recordAt !== undefined && first > t.recordAt) out.push(`the first correction at ${iso(first)} came after the resolution record at ${iso(t.recordAt)}`);
  if (t.recordAt !== undefined && t.unpendedAt !== undefined && t.recordAt > t.unpendedAt) out.push(`the resolution record at ${iso(t.recordAt)} came after pending was removed at ${iso(t.unpendedAt)}`);
  if (first !== undefined && t.unpendedAt !== undefined && first > t.unpendedAt) out.push(`the first correction at ${iso(first)} came after pending was removed at ${iso(t.unpendedAt)}`);
  return out;
}

/** The R3.46 protected paths, plus the role Skill paths the base `.nibfin.json` names. */
export function isProtected(path: string, skillPaths: string[]): boolean {
  const p = path.replace(/^\.\//, '');
  return (
    p === '.nibfin.json' ||
    p.startsWith('.nibfin/') ||
    p.startsWith('.rulesync/') ||
    p.startsWith('.github/workflows/') ||
    p === 'CODEOWNERS' ||
    p === '.github/CODEOWNERS' ||
    p === 'docs/CODEOWNERS' ||
    skillPaths.some((s) => s.replace(/^\.\//, '') === p)
  );
}

/** Every `skills.<role>.path` in a `.nibfin.json` text; an unreadable file names none. */
export function skillPathsOf(config: string | undefined): string[] {
  if (!config) return [];
  try {
    const skills = (JSON.parse(config) as { skills?: Record<string, { path?: unknown }> }).skills ?? {};
    return Object.values(skills).flatMap((s) => (s && typeof s.path === 'string' ? [s.path] : []));
  } catch {
    return [];
  }
}

export type Settings = Record<string, string | boolean | null>;

const SETTING_KEYS = ['allow_rebase_merge', 'allow_squash_merge', 'allow_merge_commit', 'delete_branch_on_merge', 'default_branch', 'visibility'] as const;

/** The repository settings this harness reads, and each ruleset's `name:enforcement`, sorted. */
export function settingsOf(repo: Record<string, unknown>, sets: { name: string; enforcement?: string }[]): Settings {
  const out: Settings = {};
  for (const key of SETTING_KEYS) {
    const v = repo[key];
    out[key] = typeof v === 'string' || typeof v === 'boolean' ? v : null;
  }
  out.rulesets = sets
    .map((r) => `${r.name}:${r.enforcement ?? 'unknown'}`)
    .sort()
    .join(',');
  return out;
}

export interface CodeChangeInput {
  activity: Activity[];
  window: { start: number; end: number };
  /** The fixture Issue's number. */
  n: number;
  defaultBranch: string;
  /** The files each default-branch write changed, by activity id (absent when unread). */
  files: Map<number, string[]>;
  skillPaths: string[];
  settingsBefore: Settings;
  settingsAfter: Settings;
}

/**
 * R4.48 problems inside the window: every branch write except on another Issue's branch
 * (those are earlier scenarios' paused fixtures), the protected paths a default-branch
 * write touched, and every changed setting.
 */
export function codeChangesIn(i: CodeChangeInput): string[] {
  const out: string[] = [];
  const win = `${iso(i.window.start)}–${iso(i.window.end)}`;
  const main = new RegExp(`^(refs/heads/)?${i.defaultBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  for (const a of i.activity) {
    if (!BRANCH_WRITES.has(a.activity_type)) continue;
    const at = time(a.timestamp);
    if (at < i.window.start || at > i.window.end) continue;
    const other = /^(refs\/heads\/)?nibfin\/issue-(\d+)/.exec(a.ref);
    if (other && !isIssueBranch(a.ref, i.n)) continue;
    let what = `${a.activity_type} to ${a.ref} at ${a.timestamp} (${a.before.slice(0, 7)}..${a.after.slice(0, 7)}) inside the resolution window ${win}`;
    if (main.test(a.ref)) {
      const files = i.files.get(a.id);
      const hit = (files ?? []).filter((f) => isProtected(f, i.skillPaths));
      if (hit.length) what += `, changing protected paths ${hit.join(', ')}`;
      else if (files === undefined) what += ', its files not read';
    }
    out.push(what);
  }
  for (const key of new Set([...Object.keys(i.settingsBefore), ...Object.keys(i.settingsAfter)])) {
    const b = i.settingsBefore[key];
    const a = i.settingsAfter[key];
    if (b !== a) out.push(`repository setting ${key} changed from ${String(b)} to ${String(a)} around the resolution window ${win}`);
  }
  return out;
}

const FIXTURE = '_This Issue is an automated nibfin-e2e fixture._';
const BEHAVIOUR = '`Hello, ${name}!`';
const CHANGE_WORD = /改|修正|更正|chang|correct|replac|edit|fix/i;

const unlabeled = (events: { event: string; created_at: string; label?: { name: string } }[], label: string, after: number) =>
  events.find((e) => e.event === 'unlabeled' && e.label?.name === label && time(e.created_at) >= after);

async function readSettings(k: Kit): Promise<Settings> {
  const { data } = await k.gh.rest<Record<string, unknown>>('GET', `/repos/${k.exec}`);
  return settingsOf(data, (await rulesets(k.gh, k.exec)) as { name: string; enforcement?: string }[]);
}

async function bodyEdits(k: Kit, n: number): Promise<number[]> {
  const [owner, name] = k.exec.split('/');
  const q = 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){userContentEdits(first:50){nodes{editedAt}}}}}';
  const d = await k.gh.graphql<{ repository: { issue: { userContentEdits: { nodes: { editedAt: string }[] } } | null } }>(q, { owner, name, n });
  return (d.repository.issue?.userContentEdits.nodes ?? []).map((e) => time(e.editedAt));
}

export const resolutionSpecFix = lifecycle({
  id: 'resolution-spec-fix',
  rules: ['R4.44', 'R4.48'],
  async run(k): Promise<Outcome> {
    const gate = await resolutionGate(k.gh, 'stage');
    if (gate) return gate;
    const c = new Checks();
    const { exec } = k;
    const owner = await k.owner();
    const slug = k.slug('greet');
    const right = `src/${slug}-greeting.js`;
    const wrong = `src/${slug}-greting.js`;
    const testPath = `test/${slug}-greeting.test.js`;
    let n: number | undefined;
    let found: ResolutionRecord | undefined;
    let window: { start: number; end: number } | undefined;
    try {
      await withRulesetLifted(k.gh, exec, CI_RULESET, () =>
        k.commitFiles(
          exec,
          'main',
          {
            [right]: 'export function greet(name) {\n  return `Hi, ${name}`;\n}\n',
            [testPath]: `import { equal } from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { greet } from '../${right}';\n\ntest('greet greets by name', () => {\n  equal(greet('Ada'), 'Hi, Ada');\n});\n`,
          },
          'Add greet for the resolution-spec-fix fixture (e2e)',
        ),
      );
      const settingsBefore = await readSettings(k);
      const issue: Issue = await k.file(exec, {
        scenario: 'resolution-spec-fix',
        title: 'Make greet say hello',
        body: [
          `Change \`greet\` in \`${wrong}\` so that \`greet(name)\` returns ${BEHAVIOUR} instead of \`Hi, \${name}\`, and update its test in \`${testPath}\`.`,
          `\`greet\` is defined only in \`${right}\`, which was added to \`main\` for this fixture.`,
          `**Included:** \`${wrong}\` and \`${testPath}\`.\n\n**Excluded:** every other file.`,
          FIXTURE,
        ].join('\n\n'),
        labels: ['scope'],
        assignees: [owner.login],
      });
      n = issue.number;
      const num = n;
      const show = k.show(exec, num);

      // 1. The stop: pending, seen on the labels or (when it came and went between polls) on the timeline.
      const shapeGone = k.stageGone(exec, num, 'shape', { allowPending: true });
      try {
        await k.obs.until(
          `#${num} to stop with pending`,
          async (s) => (k.labels(s, exec, num).includes('pending') || (await k.labeledAt(exec, num, 'pending')) !== undefined ? true : undefined),
          DEADLINE.stage,
          show,
          { gonePast: async (s) => (k.labels(s, exec, num).includes('shaped') ? `#${num} has shaped: Shape published without stopping, so the fixture did not need a correction` : shapeGone(s)) },
        );
      } catch (error) {
        c.fail('R4.44', message(error));
        return c.outcome('');
      }
      const pendingAt = await pendingAddedAt(k.gh, exec, num);

      // 2. The resolution: pending removed by Nibfin (the harness never removes it here).
      let unpendedAt: number | undefined;
      try {
        unpendedAt = await k.obs.until(
          `the resolution stage to remove pending from #${num}`,
          async () => {
            const ev = unlabeled(await k.obs.timeline(exec, num), 'pending', pendingAt);
            return ev ? time(ev.created_at) : undefined;
          },
          DEADLINE.stage,
          show,
          {
            gonePast: async (s) => {
              const i = k.issue(s, exec, num);
              if (i?.state === 'closed') return `#${num} is closed (${String(i.state_reason)})`;
              const r = resolutionRecord(await k.obs.comments(exec, num), pendingAt);
              if (r && r.class !== 'issue-correction' && k.labels(s, exec, num).includes('pending') && s.at - r.at >= PUBLISH_GRACE) {
                return `the resolution record ${r.url} gives ${r.class ?? r.classLabel ?? 'no class'}, not Issue 規格需修正, and pending stayed ${Math.floor((s.at - r.at) / 60_000)} min: ${briefRecord(r.body)}`;
              }
              return undefined;
            },
          },
        );
      } catch (error) {
        c.fail('R4.44', message(error));
      }
      window = { start: pendingAt, end: unpendedAt ?? k.now() };

      // 3. One read of what happened in the window.
      const events = await k.gh.list<{ event: string; created_at: string }>(`/repos/${exec}/issues/${num}/timeline`);
      const blockedByAdded = events.filter((e) => e.event === 'blocked_by_added').map((e) => time(e.created_at)).filter((t) => t >= pendingAt);
      const comments = await k.gh.list<Comment>(`/repos/${exec}/issues/${num}/comments`);
      found = resolutionRecord(comments, pendingAt);
      const edits = (await bodyEdits(k, num)).filter((t) => t >= pendingAt);
      const { data: now } = await k.gh.rest<Issue>('GET', `/repos/${exec}/issues/${num}`);
      const body = now.body ?? '';

      // 4. R4.44.
      if (unpendedAt !== undefined) {
        if (!found) c.fail('R4.44', `no resolution record on #${num} after pending was added at ${iso(pendingAt)}`);
        else {
          const brief = briefRecord(found.body);
          c.check('R4.44', found.class === 'issue-correction', `the resolution record ${found.url} gives ${found.class ?? found.classLabel ?? 'no class'}, not Issue 規格需修正: ${brief}`);
          const says = found.body.includes(right) || (found.body.includes(wrong) && CHANGE_WORD.test(found.body)) || (blockedByAdded.length > 0 && /blocked\s*by/i.test(found.body));
          c.check('R4.44', says, `the resolution record ${found.url} does not say what it changed (neither ${right}, nor ${wrong} with a change word): ${brief}`);
        }
        c.none('R4.44', specFixOrder({ pendingAt, edits, blockedByAdded, recordAt: found?.at, unpendedAt }).map((p) => `${p} (read: GraphQL userContentEdits, timeline, comments)`));
        c.check('R4.44', edits.length > 0, `#${num}'s body was not edited after ${iso(pendingAt)} (GraphQL userContentEdits), but its wrong path only a body edit corrects`);
        // The filed body names the meant file once (where greet is defined); the correction names it where the wrong path was.
        c.check('R4.44', body.split(right).length - 1 >= 2, `#${num}'s body does not name ${right} where ${wrong} was (it names ${right} ${body.split(right).length - 1} time(s), as filed: 1)`);
        c.check('R4.44', body.includes(BEHAVIOUR) && body.includes('greet'), `#${num}'s body no longer asks greet to return ${BEHAVIOUR}: the correction changed the requested behaviour`);
      }

      // 5. R4.48: no branch, protected-path or setting change in the window.
      await k.obs.fresh();
      const activity = await k.obs.activity(exec);
      const defaultBranch = String(settingsBefore.default_branch ?? 'main');
      const skillPaths = skillPathsOf(await k.fileOn(exec, defaultBranch, '.nibfin.json'));
      const files = new Map<number, string[]>();
      for (const a of activity) {
        const at = time(a.timestamp);
        if (!BRANCH_WRITES.has(a.activity_type) || at < window.start || at > window.end || a.ref.replace(/^refs\/heads\//, '') !== defaultBranch || /^0+$/.test(a.before)) continue;
        const { data } = await k.gh.rest<{ files?: { filename: string }[] }>('GET', `/repos/${exec}/compare/${a.before}...${a.after}`);
        files.set(a.id, (data.files ?? []).map((f) => f.filename));
      }
      const settingsAfter = await readSettings(k);
      c.none('R4.48', codeChangesIn({ activity, window, n: num, defaultBranch, files, skillPaths, settingsBefore, settingsAfter }));

      // 6. The Issue continues on its own: a Shape after pending was removed.
      if (unpendedAt !== undefined) {
        const since = unpendedAt;
        try {
          await k.obs.until(
            `#${num} to be shaped after the correction`,
            async (s) => {
              if (!k.labels(s, exec, num).includes('shaped')) return undefined;
              const cs = await k.obs.comments(exec, num);
              return cs.some((x) => SHAPE_MARKER.test(markerOf(x.body) ?? '') && Math.max(time(x.created_at), time(x.updated_at)) >= since) ? true : undefined;
            },
            DEADLINE.stage,
            show,
            { gonePast: k.stageGone(exec, num, 'shape', { publishes: 'shaped', since }) },
          );
        } catch (error) {
          c.fail('R4.44', `the Issue did not continue on its own: ${message(error)}`);
        }
      }
    } catch (error) {
      c.fail(window ? 'R4.48' : 'R4.44', message(error));
    } finally {
      await k.pauseOpen(exec, [n]);
    }
    const read = window ? `window ${iso(window.start)}–${iso(window.end)} read from repository activity, compare, the repository and its rulesets` : 'no window';
    return c.outcome(`#${n}: the resolution record (${found?.class ?? 'no class'}) said it corrected ${wrong} to ${right}, pending was removed after the edit and the Issue was shaped; no branch, protected-path or setting change in the ${read}`);
  },
});
