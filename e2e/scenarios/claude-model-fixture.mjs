import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { workerFixture, capturedMounts } from './claude-worker-fixture.mjs';
import { coreModule } from './isolation-common.mjs';

export async function modelFixture(context, binding = {}) {
  const { createClaudePrivateRunner, claudeModelComponent } =
    await coreModule(context, 'src/claude-model-runner.mjs');
  const { claudePlan } = await coreModule(context, 'src/claude-plan.mjs');
  const { digest } = await coreModule(context, 'src/identity.mjs');
  const f = await workerFixture(context, 'deliver', binding);
  try {
    const modelId = 'd'.repeat(64);
    const key = 'sk-ant-' + 'synthetic'.repeat(8);
    const modelEgress = { ...f.egress, gatewayId: 'e'.repeat(64),
      network: f.egress.network.replace('work', 'model') };
    await writeFile(join(f.egress.directory, 'claude-model-proxy.mjs'),
      await readFile(join(context.sources.core.checkout, 'src/claude-model-proxy.mjs')));
    const plan = binding.plan ?? claudePlan('deliver', { context: {},
      skill: { identity: 'deliver', content: 'Protected', hash: digest('Protected') },
      modelProfile: { model: 'claude-configured' } }, claudeModelComponent);
    const controls = { modelUnknown: false, modelExists: false };
    const calls = [];
    let model;
    const host = f.host;
    const run = async (exe, args, options) => {
      const cmd = args.slice(2);
      calls.push(cmd);
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.ok(!args.some(arg => arg.includes(key)));
      const reply = value => ({ stdout: Buffer.from(typeof value === 'string' ? value :
        JSON.stringify(value)), stderr: Buffer.alloc(0), exitCode: 0 });
      if (cmd[0] === 'create' && cmd.includes('--user=1001:1001')) {
        controls.modelExists = true;
        model = { Id: modelId, Name: '/' + cmd[cmd.indexOf('--name') + 1],
          State: { Status: 'created' }, AppArmorProfile: 'codex-security-container',
          Config: { Image: f.config.image, User: '1001:1001', WorkingDir: '/session',
            OpenStdin: true, Entrypoint: [cmd[cmd.indexOf('--entrypoint') + 1]],
            Cmd: cmd.slice(cmd.indexOf(f.config.image) + 1),
            Env: cmd.flatMap((arg, i) => arg === '--env' ? [cmd[i + 1]] : []) },
          HostConfig: { LogConfig: { Type: 'none' }, Privileged: false,
            ReadonlyRootfs: true, NetworkMode: modelEgress.network,
            Dns: ['127.0.0.1'], IpcMode: 'none', Memory: 2147483648,
            MemorySwap: 2147483648, NanoCpus: 1000000000, PidsLimit: 128,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges', 'apparmor=codex-security-container'],
            Tmpfs: Object.fromEntries(cmd.filter(arg => arg.startsWith('--tmpfs='))
              .map(arg => arg.slice(8).split(/:(.*)/s).slice(0, 2))) },
          Mounts: capturedMounts(cmd),
          NetworkSettings: { Networks: { [modelEgress.network]: {} } },
        };
        controls.mutate?.(model);
        return reply(modelId);
      }
      if (cmd[0] === 'inspect' && cmd[1] === modelId) return reply([model]);
      if (cmd[0] === 'start' && cmd[1] === '-ai') {
        assert.equal(JSON.parse(options.input).key, key);
        await controls.executing?.();
        return reply(controls.output ?? 'model output');
      }
      if (cmd[0] === 'ps' && cmd.at(-1).includes('nibfin-claude-model-')) {
        if (controls.modelUnknown) throw new Error('model daemon unreachable');
        return reply(controls.modelExists ? modelId : '');
      }
      if (cmd[0] === 'rm' && cmd.at(-1).startsWith('nibfin-claude-model-')) {
        controls.modelExists = false;
        return reply('');
      }
      if (cmd[0] === 'image') {
        const value = JSON.parse((await f.run(exe, args, options)).stdout);
        value[0].Config.Labels = {
          'io.nibfin.claude-version': claudeModelComponent.cli.version };
        return reply(value);
      }
      if (cmd[0] === 'network' && cmd.at(-1) === modelEgress.network ||
        cmd[0] === 'inspect' && cmd[1] === modelEgress.gatewayId) {
        const translated = args.map(arg => arg === modelEgress.network ?
          f.egress.network : arg === modelEgress.gatewayId ? f.egress.gatewayId : arg);
        const value = (await f.run(exe, translated, options)).stdout.toString()
          .replaceAll(f.egress.network, modelEgress.network)
          .replaceAll(f.egress.gatewayId, modelEgress.gatewayId)
          .replaceAll('claude-package-proxy.mjs', 'claude-model-proxy.mjs');
        return reply(value);
      }
      return f.run(exe, args, options);
    };
    const runner = createClaudePrivateRunner({ ...f.config, modelEgress,
      worker: { container: f.config, mounts: f.admission, egress: f.egress } },
    { run, host, backend: f.backend, readKey: async () => key });
    const execute = () => runner.execute({ plan, executionId: f.admission.executionId,
      session: f.admission.session });
    return { ...f, modelControls: controls,
      workerControls: f.controls, runner, execute, plan, key, calls,
      admissionFile: join(f.admission.session, 'work-admission.json'),
      channel: dirname(join(f.admission.session, 'work-channel', 'worker.sock')) };
  } catch (error) {
    await f.close();
    throw error;
  }
}
