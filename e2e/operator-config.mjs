import { lstat, realpath, readFile, access } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { defectConfiguration } from './defect-policy.mjs';

export const overlaps = (a, b) => a === b || a.startsWith(b + sep) ||
  b.startsWith(a + sep);

// Setup is operator-owned and never loaded from a scenario or repository.
export async function privatePath(path, directory = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path ||
      await realpath(path) !== path) throw new Error('OPERATOR_PATH_UNSAFE');
  const stat = await lstat(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) ||
      (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('OPERATOR_PATH_UNSAFE');
  }
  // Reject replaceable ancestors, including symlinks. Sticky system temp roots
  // are safe ancestors only; each actual resource still requires private mode.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const row = await lstat(parent);
    if (!row.isDirectory() || ![0, process.getuid()].includes(row.uid) ||
        (row.mode & 0o022) && !(row.mode & 0o1000)) {
      throw new Error('OPERATOR_PATH_UNSAFE');
    }
    if (dirname(parent) === parent) break;
  }
  return stat;
}

export async function operatorConfiguration(path, agent = 'codex') {
  const config = await operatorBoundaries(path, agent);
  await operatorAvailability(config);
  return config;
}

async function optionalPrivatePath(path, directory = false) {
  try { await privatePath(path, directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
      throw new Error('OPERATOR_PATH_UNSAFE');
    }
    await privatePath(dirname(path), true);
  }
}

export async function operatorBoundaries(path, agent = 'codex') {
  if (!['codex', 'claude'].includes(agent)) {
    throw new Error('OPERATOR_AGENT_UNSUPPORTED');
  }
  const stat = await privatePath(path);
  if (stat.size > 16000) throw new Error('OPERATOR_CONFIGURATION');
  const value = JSON.parse(await readFile(path, 'utf8'));
  const fields = ['version', 'authorization', 'configuration', 'publicationMode',
    'codexExecutable', 'codexHome', 'credentialFile', 'stateDir', 'scratchRoot',
    'suiteRoot', 'evidence', 'claudeExecutable', 'claudeCredentialFile'];
  if (Object.keys(value).some(key => !fields.includes(key)) ||
      value.version !== 1 || value.authorization !== 'publish-public-defects' ||
      value.publicationMode !== 'issue-events') {
    throw new Error('OPERATOR_CONFIGURATION');
  }
  const providerFields = agent === 'claude' ?
    ['claudeExecutable', 'claudeCredentialFile'] : ['codexExecutable', 'codexHome'];
  if (providerFields.some(key => typeof value[key] !== 'string' || !value[key])) {
    throw new Error('OPERATOR_AGENT_UNCONFIGURED');
  }
  const configuration = defectConfiguration(value.configuration);
  const privateRoots = ['stateDir', 'scratchRoot', 'suiteRoot'];
  for (const name of privateRoots) await privatePath(value[name], true);
  if (agent === 'codex') {
    await optionalPrivatePath(value.codexHome, true);
    privateRoots.push('codexHome');
  } else await optionalPrivatePath(value.claudeCredentialFile);
  // Missing publication authentication must not prevent read-only modeling.
  const credential = value.credentialFile;
  if (typeof credential !== 'string' || !isAbsolute(credential) ||
      resolve(credential) !== credential) throw new Error('OPERATOR_PATH_UNSAFE');
  try { await privatePath(credential); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await privatePath(dirname(credential), true);
    if (await realpath(dirname(credential)) !== dirname(credential)) {
      throw new Error('OPERATOR_PATH_UNSAFE');
    }
  }
  const boundaries = [path, value.credentialFile,
    ...(agent === 'claude' ? [value.claudeCredentialFile] : []),
    ...privateRoots.map(name => value[name])];
  for (let index = 0; index < boundaries.length; index++) {
    if (overlaps(boundaries[index], await realpath(process.cwd())) ||
        boundaries.slice(index + 1).some(other => overlaps(boundaries[index], other))) {
      throw new Error('OPERATOR_ROOT_OVERLAP');
    }
  }
  const executable = value[`${agent}Executable`];
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    throw new Error('OPERATOR_EXECUTABLE');
  }
  await validateExecutable(executable, true);
  // No inherited repository/project configuration discovery in scratch parents.
  for (let parent = value.scratchRoot; ; parent = dirname(parent)) {
    for (const name of ['.git', '.codex/config.toml', 'AGENTS.md',
      '.claude', 'CLAUDE.md']) {
      let exists = false;
      try { await access(resolve(parent, name)); exists = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (exists) throw new Error('OPERATOR_PROJECT_DISCOVERY');
    }
    if (dirname(parent) === parent) break;
  }
  if (!Array.isArray(value.evidence) || !value.evidence.length ||
      value.evidence.length > 30) throw new Error('OPERATOR_EVIDENCE');
  const evidence = value.evidence.map(row => {
    if (!configuration.targets.some(target => target.repository === row.repository) ||
        !['source', 'callers'].includes(row.kind) ||
        !/^[a-zA-Z0-9_/-]+\.(mjs|js|ts|go|rs|py)$/.test(row.path ?? '') ||
        row.path.split('/').some(part => !part || part === '..')) {
      throw new Error('OPERATOR_EVIDENCE');
    }
    return { repository: row.repository, kind: row.kind, path: row.path };
  });
  for (const target of configuration.targets) {
    if (!['source', 'callers'].every(kind => evidence.some(row =>
      row.repository === target.repository && row.kind === kind))) {
      throw new Error('OPERATOR_EVIDENCE');
    }
  }
  return Object.freeze({ ...value, agent, configuration, evidence });
}

export async function rejectManagedProvider(agent) {
  const paths = agent === 'claude' ? ['/etc/claude-code',
    '/etc/claude', '/usr/local/etc/claude-code'] : ['/etc/codex'];
  for (const path of paths) {
    try { await access(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('OPERATOR_MODEL_SYSTEM_CONFIGURATION');
  }
}

async function validateExecutable(executable, allowMissing = false) {
  if (resolve(executable) !== executable) {
    throw new Error('OPERATOR_EXECUTABLE');
  }
  for (let parent = dirname(executable); ; parent = dirname(parent)) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || ![0, process.getuid()].includes(stat.uid) ||
        (stat.mode & 0o022) && !(stat.mode & 0o1000)) {
      throw new Error('OPERATOR_EXECUTABLE');
    }
    if (dirname(parent) === parent) break;
  }
  let canonical;
  try { canonical = await realpath(executable); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (allowMissing) return;
    throw new Error('OPERATOR_AGENT_UNAVAILABLE');
  }
  if (canonical !== executable) throw new Error('OPERATOR_EXECUTABLE');
  const tool = await lstat(executable);
  if (!tool.isFile() || ![0, process.getuid()].includes(tool.uid) ||
      tool.mode & 0o022 || !(tool.mode & 0o111)) {
    throw new Error('OPERATOR_EXECUTABLE');
  }

}

export async function operatorAvailability(config) {
  if (config.agent === 'codex') await privatePath(config.codexHome, true);
  else {
    try { await privatePath(config.claudeCredentialFile); }
    catch { throw new Error('OPERATOR_AGENT_AUTHENTICATION'); }
  }
  await validateExecutable(config[`${config.agent}Executable`]);
}
