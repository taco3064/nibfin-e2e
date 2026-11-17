import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sourceCommand } from '../source-process.mjs';
import { coreModule } from './isolation-common.mjs';
import { modelFixture } from './claude-model-fixture.mjs';

const outcomes = { shape: 'ready', 'validate-shape': 'approved', deliver: 'ready',
  accept: 'accepted', 'review-pr': 'approved' };
const modelTimeoutMs = 5000;
// One request runs every role for an Issue, plus component setup and settlement.
export const roleChainTimeoutMs = modelTimeoutMs * (Object.keys(outcomes).length + 1);

// Trusted composition only. The executable is a bounded local double; Docker,
// provider credentials, effective host inspections and work effects are synthetic.
export async function deliveryAgent(context) {
  const { ClaudeRoleAgent } = await coreModule(context, 'src/claude-agent.mjs');
  const { claudeModelComponent } =
    await coreModule(context, 'src/claude-model-runner.mjs');
  const { digest } = await coreModule(context, 'src/identity.mjs');
  const root = await mkdtemp(join(context.tempDir ?? tmpdir(), 'claude-delivery-'));
  const held = new Map();
  const release = async f => {
    await f.runner.requestCleanup(f.admission.executionId);
    if (!f.retired) await f.runner.retire(f.admission.executionId);
    await f.close();
  };
  return {
    root,
    get pending() { return held.size; },
    async settle() {
      // Called only with separate, explicit fixture settlement evidence.
      for (const [id, f] of held) {
        f.modelControls.modelUnknown = false;
        f.workerControls.cleanupUnknown = false;
        await release(f);
        held.delete(id);
      }
    },
    async run(stage, binding, agent, mode = 'success') {
      let f;
      const abort = new AbortController();
      const runner = { contract: claudeModelComponent.runner,
        async execute(request) {
          f = await modelFixture(context, { ...request, signal: abort.signal });
          const value = { type: 'result', subtype: 'success', is_error: false,
            session_id: binding.execution.sessionId, structured_output: {
              outcome: outcomes[stage], body: binding.shape.body,
              summary: 'Controlled delivery', rootCause: '', failureClass: 'none',
              evidenceReferences: ['controlled'], blockingFindings: [],
              contractConflicts: [],
            } };
          const output = mode === 'invalid' ? '{"type":"result"}' :
            JSON.stringify(value);
          const executable = join(f.root, 'model-double.mjs');
          await writeFile(executable, mode === 'timeout' ?
            'setInterval(() => {}, 1000);\n' :
            `process.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o600 });
          f.modelControls.process = async () => {
            let result;
            try {
              result = await sourceCommand(process.execPath, [executable], {
                cwd: f.root, env: { PATH: '/usr/bin:/bin' },
                timeoutMs: mode === 'timeout' ? 100 : modelTimeoutMs, limit: 65536,
              });
            } catch (error) {
              if (error.message === 'SOURCE_COMMAND_TIMEOUT') {
                throw Object.assign(new Error('controlled timeout'),
                  { code: 'PROCESS_TIMEOUT' });
              }
              throw error;
            }
            if (mode === 'interrupted') abort.abort();
            if (mode === 'unknown') f.modelControls.modelUnknown = true;
            return { stdout: Buffer.from(result.stdout),
              stderr: Buffer.from(result.stderr), exitCode: 0 };
          };
          return f.runner.execute(request);
        },
        requestCleanup: id => f.runner.requestCleanup(id),
        assertOutputSafe: (...args) => f.runner.assertOutputSafe(...args),
        async retire(id) { await f.runner.retire(id); f.retired = true; },
      };
      const identity = ['validate-shape', 'review-pr'].includes(stage) ? 'shape' : stage;
      const content = 'Controlled role: only Deliver may write the Candidate.';
      const adapter = new ClaudeRoleAgent(claudeModelComponent, runner, root);
      try {
        const result = await adapter.run(stage, binding, {
          skill: { identity, content, hash: digest(content) },
          modelProfile: { model: agent.model },
        });
        assert.equal(result.status === 'interrupted' ||
          result.result.outcome === outcomes[stage], true);
        return result;
      } finally {
        if (f) {
          try { await release(f); }
          catch { held.set(binding.execution.id, f); }
        }
      }
    },
    async close() {
      if (held.size) throw new Error('CLAUDE_SETTLEMENT_REQUIRED');
      await rm(root, { recursive: true, force: true });
    },
  };
}
