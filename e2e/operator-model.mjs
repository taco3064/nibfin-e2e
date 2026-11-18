import { operatorInput } from './operator-input.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { privatePath } from './operator-config.mjs';
import { sourceCommand, sourceTerminationUnknown } from './source-process.mjs';

const toml = value => value && typeof value === 'object' ?
  `{ ${Object.entries(value).map(([key, item]) =>
    `${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }` : JSON.stringify(value);

// Configuration is code-owned. No model/scenario value becomes a permission,
// executable, environment variable or configuration key.
export function operatorModelPlan(config, root, schema) {
  const home = join(root, 'tools');
  const settings = {
    approval_policy: 'never', default_permissions: 'e2e', web_search: 'disabled',
    'features.apps': false, 'features.multi_agent': false,
    'skills.bundled.enabled': false, mcp_servers: {}, hooks: {},
    project_doc_max_bytes: 0,
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.experimental_use_profile': false,
    'shell_environment_policy.set': { HOME: home, TMPDIR: home,
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    'permissions.e2e.filesystem': {
      ':minimal': 'read', [root]: 'read', [home]: 'write',
      '/usr/bin': 'read', '/usr/lib': 'read', '/usr/share': 'read',
      [config.codexHome]: 'deny', [join(root, 'private-auth')]: 'deny',
      [config.credentialFile]: 'deny',
      [config.stateDir]: 'deny', [config.suiteRoot]: 'deny',
    },
    'permissions.e2e.network.enabled': false,
  };
  return {
    args: [...Object.entries(settings).flatMap(([key, value]) =>
      ['-c', `${key}=${toml(value)}`]), 'exec', '--strict-config',
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--ephemeral', '--json', '--output-schema', schema,
    '--output-last-message', join(root, 'result.json'), '-'],
    cwd: root,
    env: { HOME: root, CODEX_HOME: join(root, 'private-auth'),
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: root },
  };
}

// Each call is a fresh conversation. Only explicitly approved text is staged;
// authentication belongs to Codex, outside all model tool read/write roots.
export function operatorModel(config, command = sourceCommand) {
  return async (input, schema, signal) => {
    if (process.platform !== 'linux') throw new Error('OPERATOR_MODEL_PLATFORM');
    // A host-managed configuration may mandate integrations or hooks which this
    // adapter cannot override. Refuse it rather than weaken host policy or run
    // unexamined integrations with model authentication.
    if (command === sourceCommand) {
      let managed = false;
      try { await access('/etc/codex'); managed = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (managed) throw new Error('OPERATOR_MODEL_SYSTEM_CONFIGURATION');
    }
    const text = JSON.stringify(input);
    const inputText = operatorInput(input);
    if (Buffer.byteLength(inputText) > 512000) throw new Error('OPERATOR_INPUT_LIMIT');
    const root = await mkdtemp(join(config.scratchRoot, 'model-'));
    let unknown = false;
    try {
      const loginPath = join(config.codexHome, 'auth.json');
      const login = await privatePath(loginPath);
      if (login.size > 64000) throw new Error('OPERATOR_MODEL_LOGIN');
      // Use only the existing model login, never host configuration, skills,
      // MCP servers, plugins or hooks. The model tool profile denies this copy.
      await mkdir(join(root, 'private-auth'), { mode: 0o700 });
      await writeFile(join(root, 'private-auth', 'auth.json'),
        await readFile(loginPath), { mode: 0o600 });
      await mkdir(join(root, 'tools'), { mode: 0o700 });
      await mkdir(join(root, 'evidence'), { mode: 0o700 });
      const schemaPath = join(root, 'schema.json');
      await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      await writeFile(join(root, 'evidence', 'input.json'), text, { mode: 0o600 });
      const plan = operatorModelPlan(config, root, schemaPath);
      await command(config.codexExecutable, plan.args, { cwd: plan.cwd, env: plan.env,
        timeoutMs: 110000, limit: 2 * 1024 * 1024, signal,
        input: inputText });
      const outputPath = join(root, 'result.json');
      const output = await lstat(outputPath);
      if (!output.isFile() || output.size > 64000) {
        throw new Error('OPERATOR_OUTPUT_LIMIT');
      }
      const result = await readFile(outputPath, 'utf8');
      if (Buffer.byteLength(result) > 64000) throw new Error('OPERATOR_OUTPUT_LIMIT');
      return JSON.parse(result);
    } catch (error) {
      unknown = sourceTerminationUnknown(error);
      throw error;
    } finally {
      if (!unknown) await rm(root, { recursive: true, force: true });
    }
  };
}
