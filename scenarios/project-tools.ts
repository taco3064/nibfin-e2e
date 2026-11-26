import type { Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import { TOOL_OUTPUT } from './lib/files.ts';
import { observedFacts } from './lib/observed-facts.ts';

/** Proposal R7.3: `tools` comes from the trusted catalog; Repository scripts and Dockerfiles never run. */
export const projectTools: Scenario = {
  id: 'project-tools',
  rules: ['R7.3'],
  platforms: ['linux'],
  requires: ['observed-job'],
  async run(ctx) {
    const f = observedFacts(ctx);
    const c = new Checks();
    for (const tool of ['node', 'python', 'go'] as const) {
      const got = f.probe?.[tool]?.[0];
      c.hold('R7.3', `${tool} is the requested ${TOOL_OUTPUT[tool]}, not the version files' one`, got?.includes(TOOL_OUTPUT[tool]) === true, got ?? 'no probe line');
    }
    const markers = [...(f.decoys?.tools ?? []).map((p) => `nibfin-tools:${p}`), ...(f.decoys?.login ?? []).map((p) => `login:${p}`)];
    c.hold('R7.3', 'no Repository Dockerfile or script ran', f.decoys !== undefined && markers.length === 0, markers.join(', ') || 'no marker');
    return c.outcome();
  },
};
