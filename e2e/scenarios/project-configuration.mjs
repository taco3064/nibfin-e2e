import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { coreModule, environment } from './isolation-common.mjs';
import { roleControls } from './project-roles.mjs';
export { prerequisite } from './isolation-common.mjs';

export async function jobControls(context, work, dispatch) {
  const { projectJob } = await coreModule(context, 'src/project-job.mjs');
  const { codexEnvironment } = await coreModule(context, 'src/codex-environment.mjs');
  const issue = { repository: 'fixture/target', repositoryId: 2 };
  const runner = { repository: 'fixture/dispatch', repositoryId: 1, target: issue };
  const file = join(work, '.nibfin.json');
  const sentinel = join(dispatch, '.nibfin.json');
  const decoy = JSON.stringify({
    tools: { go: '1.24.0' }, allowedDomains: ['dispatch.example.com'],
  });
  await writeFile(sentinel, decoy);
  const hostPath = process.env.PATH;
  const setup = () => projectJob({ workspace: { work }, runner, issue }, x => x);
  const absent = (await setup())({});
  assert.deepEqual(absent.project, {});
  assert.equal(await absent.toolEnvironment(), null);
  const first = { tools: { node: '22.15.0' },
    allowedDomains: ['first.example.com'] };
  const second = { tools: { python: '3.13.7' },
    allowedDomains: ['second.example.com'] };
  await writeFile(file, JSON.stringify(first));
  const job = await setup();
  const a = job({});
  await writeFile(file, JSON.stringify(second));
  assert.deepEqual(job({}).project, first);
  assert.equal(job({}).project, a.project);
  assert.throws(() => a.project.allowedDomains.push('foreign.example.com'));
  const b = (await setup())({});
  assert.deepEqual(b.project, second);
  for (const selected of [a, b, absent]) {
    const captured = [];
    class Consumer {
      constructor(config, options) { captured.push({ config, options }); }
    }
    const hooks = { docker: '/fixture/docker', socket: '/fixture/socket',
      image: 'fixture-image' };
    await codexEnvironment({ kind: 'linux-rootless-docker-v1', agent: hooks,
      hooks }, context.sources.core.checkout, undefined, selected.project, {
      AgentSandbox: Consumer, HookSandbox: Consumer,
      toolEnvironment: async () => null,
    });
    assert.equal(captured.length, 2);
    assert.deepEqual(captured[0].config.projectTools, selected.project.tools);
    assert.deepEqual(captured[0].config.additionalDomains,
      selected.project.allowedDomains);
    assert.deepEqual(captured[1].options.projectTools, selected.project.tools);
    assert.deepEqual(captured[1].config, hooks);
  }
  await assert.rejects(projectJob({ workspace: { work }, runner,
    issue: { ...issue, repositoryId: 99 } }, x => x),
  { code: 'HOST_WORKSPACE_SUBJECT_CHANGED' });
  for (const invalid of ['{', { tools: { ruby: '3.0.0' } },
    { allowedDomains: ['*.example.com'] }, { runner: 'arbitrary' },
    { skills: { shape: { mode: 'override', path: '../escape.md' } } }]) {
    await writeFile(file, typeof invalid === 'string'
      ? invalid : JSON.stringify(invalid));
    await assert.rejects(setup(), { code: 'PROJECT_CONFIG_INVALID' });
  }
  await rm(file);
  await symlink(sentinel, file);
  await assert.rejects(setup(), { code: 'PROJECT_CONFIG_INVALID' });
  await rm(file);
  assert.equal(await readFile(sentinel, 'utf8'), decoy);
  assert.equal(process.env.PATH, hostPath);
  return { a, b };
}

export async function run(context) {
  // Worker owns this directory; execution.mjs terminates it before removing files.
  const work = join(context.tempDir, 'target');
  const dispatch = join(context.tempDir, 'dispatch');
  await mkdir(work); await mkdir(dispatch);
  try {
    const selections = await jobControls(context, work, dispatch);
    const roles = await roleControls(context, work, dispatch, selections);
    return { jobs: true, roles,
      observation: environment(context,
        'local synthetic contract; no live host/network') };
  } catch {
    throw new Error('PROJECT_CONFIGURATION_CONTRACT_FAILED');
  }
}
export function verify(actual) {
  return actual?.jobs === true && actual?.roles === true;
}
export function describe(actual) { return JSON.stringify(actual.observation); }
