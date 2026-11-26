import type { Scenario } from '../../src/types.ts';
import { Check } from '../lib/check.ts';
import { allHelp } from '../lib/gh.ts';
import { nibfinFacts } from '../lib/github.ts';

const POOL = /\bpools?\b/i;

/** The lines of `text` that say Pool, trimmed. */
export function poolLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => POOL.test(l)).map((l) => l.trim().slice(0, 120));
}

export const wording: Scenario = {
  id: 'wording',
  rules: ['R5.19'],
  platforms: ['linux'],
  requires: ['nibfin'],
  async run(ctx) {
    const c = new Check();
    const help = await allHelp((args) => ctx.ghNibfin(args));
    for (const [path, text] of help) {
      const hits = poolLines(text);
      c.that(!hits.length, 'R5.19', `gh nibfin ${path ? path + ' ' : ''}--help says Pool: ${hits.slice(0, 3).join(' | ')}`);
    }
    for (const cmd of nibfinFacts(ctx).commands) {
      const hits = poolLines(cmd.stdout + '\n' + cmd.stderr);
      c.that(!hits.length, 'R5.19', `the output of gh nibfin ${cmd.args.join(' ')} says Pool: ${hits.slice(0, 3).join(' | ')}`);
    }
    return c.outcome(`no Pool in the help of ${help.size} commands or in the output of runner add and init`);
  },
};
