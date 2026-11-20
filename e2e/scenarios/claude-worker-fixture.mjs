import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreModule } from './isolation-common.mjs';
const executionId = '00000000-0000-4000-8000-000000000001';
const image = `sha256:${'a'.repeat(64)}`;
const id = 'b'.repeat(64), gatewayId = 'c'.repeat(64);

// Convert captured launch mounts into a synthetic effective inspection.
export function capturedMounts(args) {
  return args.flatMap((value, i) => value === '--mount' ? [args[i + 1]] : [])
    .map(value => {
      const fields = Object.fromEntries(value.split(',').map(p => p.split('=')));
      return { Type: fields.type, Source: fields.src, Destination: fields.dst,
        RW: !value.split(',').includes('readonly'),
        Propagation: fields['bind-propagation'] };
    });
}

export function capturedTmpfs(args) {
  return Object.fromEntries(args.filter(arg => arg.startsWith('--tmpfs='))
    .map(arg => arg.slice(8).split(/:(.*)/s).slice(0, 2)));
}

// Synthetic command and host observations; no command is spawned.
export async function workerFixture(context, stage = 'deliver', binding = {},
  tempRoot = context.tempDir ?? tmpdir()) {
  const { ClaudeWorkWorker } = await coreModule(context,
    'src/claude-work-launcher.mjs');
  const root = await mkdtemp(join(tempRoot, 'claude-work-'));
  try {
    const admission = { executionId: binding.executionId ?? executionId, stage,
      peer: { uid: 101001, gid: 201001 } };
    for (const name of ['work', 'main', 'input', 'session']) {
      admission[name] = join(root, name);
      await mkdir(admission[name]);
    }
    if (binding.session) admission.session = binding.session;
    const directory = join(root, 'proxy');
    await mkdir(directory);
    for (const name of ['egress-proxy.mjs', 'claude-package-proxy.mjs'])
      await writeFile(join(directory, name),
        await readFile(join(context.sources.core.checkout, `src/${name}`)));
    const egress = { image, gatewayId, directory, network: `nibfin-work-${executionId}` };
    const namespace = { uidStart: 100000, gidStart: 200000, size: 65536 };
    const backend = { kind: 'linux-rootful-docker-v1', namespace };
    const host = { platform: 'linux', uid: 1000, gids: [200],
      rootOwnedPath: async () => {}, realpath: async path => path,
      lstat: async path => ({ isSocket: () => true,
        uid: path.endsWith('worker.sock') ? 101000 : 0,
        gid: path.endsWith('worker.sock') ? 201000 : 200,
        mode: path.endsWith('worker.sock') ? 0o666 : 0o660 }) };
    const config = { docker: '/usr/bin/docker', socket: '/run/nibfin-engine/docker.sock',
      image };
    const calls = [];
    let container, exists = false, running = false;
    const controls = { cleanupUnknown: false, foreignNetwork: false };
    const run = async (exe, args, options) => {
      assert.equal(exe, config.docker);
      assert.deepEqual(args.slice(0, 2), ['--host', `unix://${config.socket}`]);
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      const cmd = args.slice(2); calls.push(cmd);
      let result = '';
      const inspection = () => ({ ...container,
        State: running ? { Running: true } : { Status: 'created' } });
      if (cmd[0] === 'info') result = {
        SecurityOptions: ['name=userns', 'name=apparmor', 'name=seccomp,profile=builtin'],
        CgroupVersion: '2', CgroupDriver: 'systemd', MemoryLimit: true,
        PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true,
      };
      else if (cmd[0] === 'image') result = [{ Id: image, Config: { Env: [] } }];
      else if (cmd[0] === 'run') result = {
        label: 'codex-security-container (enforce)',
        uidMap: '0 100000 65536', gidMap: '0 200000 65536',
      };
      else if (cmd[0] === 'network') result = [{ Name: egress.network, Driver: 'bridge',
        Internal: true,
        Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
        Containers: { [gatewayId]: {},
          ...(controls.foreignNetwork ? { foreign: {} } : {}) },
      }];
      else if (cmd[0] === 'inspect' && cmd[1] === gatewayId) result = [{
        Id: gatewayId, State: { Running: true }, Config: { Image: image, Env: [],
          Entrypoint: ['node'], Cmd: ['/proxy/claude-package-proxy.mjs'] },
        HostConfig: { Privileged: false, ReadonlyRootfs: true,
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] },
        NetworkSettings: { Networks: { [egress.network]: { IPAddress: '172.20.0.2' } } },
        Mounts: ['egress-proxy.mjs', 'claude-package-proxy.mjs'].map(name => ({
          Type: 'bind', Source: join(directory, name), Destination: `/proxy/${name}`,
          RW: false,
        })),
      }];
      else if (cmd[0] === 'create') {
        exists = true;
        const mounts = capturedMounts(cmd);
        container = { Id: id, Name: `/${cmd[cmd.indexOf('--name') + 1]}`,
          State: { Status: 'created' }, AppArmorProfile: 'codex-security-container',
          Config: { Image: image, User: '1000:1000', WorkingDir: '/work',
            Entrypoint: ['/usr/local/bin/python3'],
            Cmd: ['-I', '-B', '/opt/nibfin/work/claude-work-worker.py'],
            Env: cmd.flatMap((value, i) => value === '--env' ? [cmd[i + 1]] : []),
          }, HostConfig: { Privileged: false, ReadonlyRootfs: true,
            NetworkMode: egress.network, Dns: ['127.0.0.1'], IpcMode: 'none',
            Memory: 4294967296, MemorySwap: 8589934592, NanoCpus: 2000000000,
            PidsLimit: 256, CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges', 'apparmor=codex-security-container'],
            Tmpfs: capturedTmpfs(cmd),
          }, Mounts: mounts, NetworkSettings: { Networks: { [egress.network]: {} } },
        };
        controls.mutate?.(container);
        result = id;
      } else if (cmd[0] === 'inspect') result = [inspection()];
      else if (cmd[0] === 'start') {
        running = true;
      } else if (cmd[0] === 'ps') {
        if (cmd.at(-1).includes('apparmor')) result = '';
        else {
          if (controls.cleanupUnknown) throw new Error('daemon unreachable');
          result = exists ? id : '';
        }
      } else if (cmd[0] === 'rm') { exists = false; running = false; }
      else throw new Error(`Unexpected command: ${cmd[0]}`);
      return { stdout: Buffer.from(typeof result === 'string' ? result :
        JSON.stringify(result)), stderr: Buffer.alloc(0) };
    };
    const worker = new ClaudeWorkWorker(config, admission,
      { run, host, backend, egress });
    return { run, worker, controls, calls, admission, root, config, host, backend, egress,
      close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
