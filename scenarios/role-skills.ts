import type { Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import { EXTEND_MARKER } from './lib/files.ts';
import { observedFacts } from './lib/observed-facts.ts';

/** Proposal R7.5, R7.6 (extend): the Repository's Shape text is appended after the built-in text. */
export const roleSkills: Scenario = {
  id: 'role-skills',
  rules: ['R7.5', 'R7.6'],
  platforms: ['linux'],
  requires: ['observed-job'],
  async run(ctx) {
    const f = observedFacts(ctx);
    const c = new Checks();
    c.hold(
      'R7.5',
      'the appended Shape text was followed (the probe block is in the published Shape)',
      f.probe !== undefined,
    );
    const line = f.probe?.first_instruction_line?.[0];
    c.hold(
      'R7.6',
      'extend keeps the built-in text first',
      line !== undefined && line.trim() !== '' && !line.includes(EXTEND_MARKER),
      line ?? 'no first_instruction_line',
    );
    return c.outcome();
  },
};
