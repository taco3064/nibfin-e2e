import { join } from 'node:path';
import { sourceCommand } from '../../source-process.mjs';
import { sourceEnvironment } from '../../source-checkout.mjs';

export async function invokeDashboardBrowser(tempDir, signal) {
  try { return await invokeBrowserCommands(tempDir, signal); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const tool = error.path === 'npm' ? 'npm' : error.path === 'go'
      ? 'Go toolchain' : 'Node runtime';
    return { stdout: JSON.stringify({ unavailable:
      `${tool} unavailable` }) };
  }
}

async function invokeBrowserCommands(tempDir, signal) {
  const root = join(tempDir, 'dashboard');
  const cwd = join(root, 'source');
  const env = { ...sourceEnvironment(root),
    // The producer's hosted route uses installed Chrome, without downloads.
    ...(process.env.GITHUB_ACTIONS === 'true' ? { GITHUB_ACTIONS: 'true' } : {}),
    NIBFIN_BROWSER_HOST: join(root, 'browser-host') };
  // Same dependency provisioning as the producer's scripts/staged/browser.go.
  // The lockfile stays unchanged; installed Chrome belongs to hosted execution.
  await sourceCommand('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd, env, signal,
  });
  await sourceCommand('go', ['build', '-buildvcs=false', '-trimpath',
    '-o', env.NIBFIN_BROWSER_HOST, './internal/dashboard/e2efixture'], {
    cwd, env, signal,
  });
  return sourceCommand(process.execPath, ['tests/browser/e2e-dashboard.mjs'], {
    cwd, env, signal,
  });
}
