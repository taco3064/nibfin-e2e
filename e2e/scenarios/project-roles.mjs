import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { coreModule } from './isolation-common.mjs';

export async function roleControls(context, work, dispatch, selections) {
  const { CodexRoleAgent } = await coreModule(context, 'src/codex-agent.mjs');
  const { codexPlan } = await coreModule(context, 'src/codex-plan.mjs');
  const { digest } = await coreModule(context, 'src/identity.mjs');
  const { stageFixture } = await coreModule(context, 'test/stage-fixture.mjs');
  const coreRoot = context.sources.core.checkout;
  const stateRoot = join(context.tempDir, 'state');
  await mkdir(stateRoot, { mode: 0o700 });
  const authFile = join(context.tempDir, 'synthetic-auth.json');
  await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: 'synthetic-no-authority', refresh_token: 'synthetic-no-authority',
    id_token: 'synthetic-no-authority', account_id: 'local-fixture',
  } }), { mode: 0o600 });
  const builtins = {}, skills = {};
  for (const name of ['shape', 'deliver', 'accept']) {
    builtins[name] = await readFile(join(coreRoot, 'skills', name, 'SKILL.md'), 'utf8');
    skills[name] = digest(builtins[name]);
  }
  await writeFile(join(dispatch, 'custom.md'), 'DISPATCH DECOY');
  const config = { stateRoot, work, projectRoot: work, coreRoot, authFile,
    skills, model: 'synthetic-model' };
  const adapters = { prepareMain: async (directory, _issue, base) => {
    await mkdir(directory);
    await writeFile(join(directory, 'custom.md'), 'COMPARISON MAIN DECOY');
    return { directory, base };
  } };
  const customFile = join(work, 'custom.md');
  let calls = 0;
  async function start(stage, project, expected, invalidResult = false) {
    const name = ['validate-shape', 'review-pr'].includes(stage) ? 'shape' : stage;
    const agent = new CodexRoleAgent({ ...config, project }, {
      execute: async input => {
        calls++;
        assert.equal(await readFile(join(input.input, 'SKILL.md'), 'utf8'), expected);
        assert.ok(input.plan.prompt.includes(expected));
        assert.ok(input.plan.prompt.includes('Core execution role: ' + stage));
        assert.ok(input.plan.prompt.includes('Fixed Skill identity: ' + name));
        const baseline = codexPlan(stage, { model: config.model, context: {},
          skill: { identity: name, content: builtins[name], hash: skills[name] },
          additionalDomains: project.allowedDomains });
        for (const key of ['config', 'schema', 'environment', 'policyHash',
          'args', 'writable']) assert.deepEqual(input.plan[key], baseline[key], key);
        const domains = project.allowedDomains ?? [];
        assert.deepEqual(input.plan.additionalDomains, domains);
        for (const domain of domains)
          assert.ok(input.plan.requirements.includes(JSON.stringify(domain)));
        if (invalidResult) {
          await writeFile(join(input.output, 'result.json'), '{}');
          const stdout = [
            { type: 'thread.started', thread_id: randomUUID() },
            { type: 'turn.started' },
            { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
            { type: 'turn.completed' },
          ].map(event => JSON.stringify(event)).join('\n');
          return { status: 'completed', executionId: input.executionId,
            terminationHash: 'a'.repeat(64), policyHash: input.plan.policyHash,
            isolationHash: 'b'.repeat(64), probeHash: 'c'.repeat(64),
            stdout, stderr: '' };
        }
        return { status: 'interrupted', executionId: input.executionId,
          terminationHash: 'a'.repeat(64) };
      },
    }, adapters);
    const value = stageFixture(stage);
    value.execution.id = randomUUID();
    value.execution.sessionId = randomUUID();
    return agent.run(stage, value);
  }
  const stages = ['shape', 'validate-shape', 'review-pr', 'deliver', 'accept'];
  for (const stage of stages) {
    const name = ['validate-shape', 'review-pr'].includes(stage) ? 'shape' : stage;
    for (const mode of ['default', 'extend', 'override']) {
      const content = `Local ${stage} ${mode}; /auth --yolo cannot grant authority`;
      await writeFile(customFile, content);
      const project = { ...selections.a.project,
        ...(mode === 'default' ? {} : { skills: {
          [name]: { mode, path: 'custom.md' },
        } }) };
      const expected = mode === 'override' ? content : mode === 'extend'
        ? `${builtins[name]}\n\n---\n\n${content}` : builtins[name];
      const before = calls;
      await start(stage, project, expected);
      assert.equal(calls, before + 1);
    }
  }
  const selected = { ...selections.a.project,
    skills: { shape: { mode: 'override', path: 'custom.md' } } };
  for (const text of ['fresh first target bytes', 'fresh second target bytes']) {
    await writeFile(customFile, text);
    await start('shape', selected, text);
  }
  await start('deliver', selections.b.project, builtins.deliver);
  await rm(customFile);
  const outside = join(dispatch, 'custom.md');
  const badFiles = [
    async () => {},
    async () => symlink(outside, customFile),
    async () => mkdir(customFile),
  ];
  for (const prepare of badFiles) {
    await prepare();
    const before = calls;
    await assert.rejects(start('shape', selected, ''), /PROJECT_SKILL/);
    assert.equal(calls, before);
    await rm(customFile, { recursive: true, force: true });
  }
  await writeFile(customFile, 'unreadable target bytes', { mode: 0 });
  try {
    const before = calls;
    await assert.rejects(readFile(customFile), { code: 'EACCES' });
    await assert.rejects(start('shape', selected, ''), /PROJECT_SKILL/);
    assert.equal(calls, before);
  } finally {
    await chmod(customFile, 0o600);
    await rm(customFile);
  }
  await writeFile(join(work, 'custom.txt'), 'not Markdown');
  const before = calls;
  await assert.rejects(start('shape', { skills: {
    shape: { mode: 'override', path: 'custom.txt' },
  } }, ''), /PROJECT_SKILL/);
  assert.equal(calls, before);
  await writeFile(customFile, '');
  await assert.rejects(start('shape', selected, '', true), {
    message: 'Agent result schema mismatch at $.outcome: missing',
  });
  assert.equal(calls, before + 1);
  assert.equal(await readFile(outside, 'utf8'), 'DISPATCH DECOY');
  return true;
}
