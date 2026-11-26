import type { Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import { observedFacts } from './lib/observed-facts.ts';

const GENERATED = ['CLAUDE.md', '.mcp.json', '.claude/skills/e2e-probe-skill/SKILL.md'];
const NEVER_COMMITTED = (p: string) => ['CLAUDE.md', '.mcp.json', 'AGENTS.md'].includes(p) || ['.claude', '.agents', '.codex'].some((d) => p === d || p.startsWith(`${d}/`));
const NOT_WORKING = /pending|fail|needs[-_ ]?auth|disabled/i;

/** Proposal R6.10, R6.17, R6.18, R6.19, R6.24: what the CLI was set up with in a Claude Job. */
export const agentSetup: Scenario = {
  id: 'agent-setup',
  rules: ['R6.10', 'R6.17', 'R6.18', 'R6.19', 'R6.24'],
  platforms: ['linux'],
  requires: ['observed-job'],
  async run(ctx) {
    const f = observedFacts(ctx);
    const c = new Checks();
    const probe = f.probe;
    const v = (k: string) => probe?.[k]?.[0];
    for (const file of GENERATED) {
      c.hold('R6.17', `rulesync generated ${file} at Job start`, v(`exists:${file}`) === 'yes', v(`exists:${file}`) ?? 'no probe line');
      c.hold('R6.18', `${file} is not tracked by git in the Job`, v(`tracked:${file}`) === 'no', v(`tracked:${file}`) ?? 'no probe line');
    }
    const committed = (f.branchPaths ?? []).filter(NEVER_COMMITTED);
    c.hold('R6.18', 'the pushed branch contains no generated agent file', f.branchPaths !== undefined && committed.length === 0, f.branchPaths ? committed.join(', ') || 'none' : 'branch not read');

    const before = f.loginBefore;
    const after = f.loginAfter;
    c.hold('R6.19', 'Nibfin set enableAllProjectMcpServers in the login volume settings', after?.enableAllProjectMcpServers === true, `before ${String(before?.enableAllProjectMcpServers)}, after ${String(after?.enableAllProjectMcpServers)}`);
    const lost = (before?.keys ?? []).filter((k) => !(after?.keys ?? []).includes(k));
    c.hold('R6.19', 'every earlier login setting is kept', after !== undefined && lost.length === 0 && after.hasToken, lost.join(', ') || `token present: ${String(after?.hasToken)}`);
    c.hold('R6.19', 'the workspace has no .claude/settings.json approving itself', v('workspace_settings') === 'absent', v('workspace_settings') ?? 'no probe line');
    const init = f.shapeLog?.init[0];
    const server = init?.mcpServers.find((s) => s.name === 'e2e-probe');
    c.hold('R6.19', 'the CLI loaded the project MCP server e2e-probe', server !== undefined && server.status !== '' && !NOT_WORKING.test(server.status), init ? JSON.stringify(init.mcpServers) : 'no init event in the Job log');

    c.hold('R6.24', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 in the agent environment', v('auto_memory') === '1', v('auto_memory') ?? 'no probe line');
    const memory = (f.memoryEntries ?? []).filter((p) => /^projects\/[^/]+\/memory$/.test(p));
    c.hold('R6.24', 'the login volume holds no auto-memory directory', f.memoryEntries !== undefined && memory.length === 0, memory.join(', ') || 'none');

    const ancestors = probe?.ancestor ?? [];
    c.hold('R6.10', 'the agent shell does not run under the CLI sandbox (bwrap)', ancestors.length > 0 && !ancestors.includes('bwrap'), ancestors.join(' < ') || 'no probe line');
    c.hold('R6.10', 'sandbox.enabled is not set in the login settings', after !== undefined && after.sandboxEnabled !== true, String(after?.sandboxEnabled));
    return c.outcome();
  },
};
