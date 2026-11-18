import { validateResult, parseProviderJson } from './operator-output.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { privatePath } from './operator-config.mjs';

function claudeArguments(schema) {
  return ['--bare', '--print', '--input-format', 'text', '--output-format', 'json',
    '--json-schema', JSON.stringify(schema), '--tools', '', '--allowedTools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', JSON.stringify({
      disableAllHooks: true, enabledPlugins: {},
    }), '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
    '--permission-mode', 'default'];
}

export const claudeFlags = claudeArguments({}).filter(arg => arg.startsWith('--'));

export async function claudePlan(config, root, schema) {
  const stat = await privatePath(config.claudeCredentialFile);
  if (stat.size > 1024) throw new Error('OPERATOR_MODEL_LOGIN');
  const key = (await readFile(config.claudeCredentialFile, 'utf8')).trim();
  if (Buffer.byteLength(key) > 1024 || !/^sk-ant-[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error('OPERATOR_MODEL_LOGIN');
  }
  await mkdir(join(root, 'config'), { mode: 0o700 });
  return {
    args: claudeArguments(schema),
    cwd: root,
    env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'),
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', ANTHROPIC_API_KEY: key,
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: root },
  };
}

export function claudeResult(stdout, schema) {
  const result = parseProviderJson(stdout);
  if (result?.type !== 'result' || result.subtype !== 'success' ||
      result.is_error !== false || !result.structured_output ||
      typeof result.structured_output !== 'object' ||
      Array.isArray(result.structured_output) ||
      Buffer.byteLength(JSON.stringify(result.structured_output)) > 64000) {
    throw new Error('OPERATOR_MODEL_OUTPUT');
  }
  if (schema) validateResult(result.structured_output, schema);
  return result.structured_output;
}
