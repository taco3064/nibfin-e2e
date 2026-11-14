import { sourceCommand } from './source-process.mjs';

export const sourceRepositories = Object.freeze([
  ['core', 'nibfin-core'], ['action', 'nibfin-act'], ['cli', 'gh-nibfin'],
].map(([id, name]) => Object.freeze({
  id, repository: `taco3064/${name}`,
  url: `https://github.com/taco3064/${name}.git`, ref: 'refs/heads/main',
})));

// No inherited Git configuration, credential helper, hooks or interactive auth.
export function sourceEnvironment(root) {
  // Writer commands have a trusted loopback proxy. Preserve that route when
  // clearing inherited Git configuration and credentials for source acquisition.
  const writerProxy = 'http://127.0.0.1:3128';
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8',
    HOME: root, TMPDIR: root, TMP: root, TEMP: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    ...(process.env.HTTPS_PROXY === writerProxy ? { HTTPS_PROXY: writerProxy } : {}),
  };
}

export async function acquireSource(source, checkout, context) {
  const { command = sourceCommand, env } = context;
  const invoke = args => command('git', args, { env, cwd: context.root });
  await invoke([
    'clone', '--no-checkout', '--depth=1', '--single-branch', '--no-tags',
    '--branch', 'main', '--', source.url, checkout,
  ]);
  // Verify the branch ref explicitly: a tag named main cannot satisfy this.
  const observed = await invoke([
    '-C', checkout, 'rev-parse', '--verify', `${source.ref.replace(
      'refs/heads/', 'refs/remotes/origin/',
    )}^{commit}`,
  ]);
  const commit = observed.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('INVALID_CHECKOUT_IDENTITY');
  await invoke(['-C', checkout, 'checkout', '--detach', commit]);
  return commit;
}
