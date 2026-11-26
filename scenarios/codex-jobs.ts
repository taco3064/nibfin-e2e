import type { Scenario } from '../src/types.ts';

/** The Codex clauses of these rules: Codex Runners arrive with Phase 5 (Proposal R8.20). */
export const codexJobs: Scenario = {
  id: 'codex-jobs',
  rules: ['R6.17', 'R6.19', 'R6.24', 'R6.27', 'R6.28'],
  platforms: ['linux'],
  async run() {
    return { status: 'waiting', reason: 'Codex Runners are not provisioned by the gate (Phase 5); the Codex clauses of R6.17, R6.19, R6.24, R6.27 and R6.28 wait for them' };
  },
};
