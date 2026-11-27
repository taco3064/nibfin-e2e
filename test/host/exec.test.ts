import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { childEnv, createExec, mustRun, resolveArgv } from '../../src/host/exec.ts';

test('children get no E2E_* variable, no NIBFIN_GITHUB_TOKEN and no inherited GH_TOKEN; GH_TOKEN only when given', () => {
  const env = { PATH: '/bin', E2E_SANDBOX_TOKEN: 's', e2e_claude_token: 'c', GH_TOKEN: 'old', NIBFIN_GITHUB_TOKEN: 'owner', nibfin_github_token: 'o2' };
  deepEqual(childEnv(env), { PATH: '/bin' });
  deepEqual(childEnv(env, 's'), { PATH: '/bin', GH_TOKEN: 's' });
});

test('npm runs through node on Windows and as is elsewhere', () => {
  deepEqual(resolveArgv(['npm', 'ci'], {}, 'linux'), ['npm', 'ci']);
  deepEqual(resolveArgv(['npm', 'ci'], { npm_execpath: 'C:\\npm\\npm-cli.js' }, 'win32', 'C:\\node\\node.exe'), ['C:\\node\\node.exe', 'C:\\npm\\npm-cli.js', 'ci']);
  deepEqual(resolveArgv(['git', 'status'], {}, 'win32'), ['git', 'status']);
});

test('the real exec passes stdin, never a shell, and filters the environment', async () => {
  const exec = createExec({ ...process.env, E2E_SANDBOX_TOKEN: 'secret-sandbox', E2E_CLAUDE_TOKEN: 'secret-claude' }, () => {});
  const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({s,keys:Object.keys(process.env).filter(k=>/E2E_|GH_TOKEN/i.test(k)),gh:process.env.GH_TOKEN})))';
  const plain = await exec([process.execPath, '-e', script], { input: 'hello $HOME' });
  deepEqual(JSON.parse(plain.stdout), { s: 'hello $HOME', keys: [] });
  const gh = await exec([process.execPath, '-e', script], { ghToken: 'gh-token' });
  deepEqual(JSON.parse(gh.stdout), { s: '', keys: ['GH_TOKEN'], gh: 'gh-token' });
  await rejects(exec(['/nonexistent/binary']), /cannot run \/nonexistent\/binary/);
});

test('mustRun reports the exit code and output, or only stderr when stdout may hold a secret', async () => {
  const exec = createExec({ ...process.env }, () => {});
  await rejects(mustRun(exec, [process.execPath, '-e', 'console.log("out-"+"secret");process.exit(3)']), /exited 3: out-secret/);
  const err = await mustRun(exec, [process.execPath, '-e', 'console.log("out-"+"secret");process.exit(3)'], { hideStdout: true }).catch((e: Error) => e.message);
  equal(String(err).includes('out-secret'), false);
});

test('the stream delivers lines, filters the environment and stops on request', async () => {
  const { createStream } = await import('../../src/host/exec.ts');
  const stream = createStream({ ...process.env, E2E_SANDBOX_TOKEN: 'secret' }, () => {});
  const lines: string[] = [];
  const script = 'console.log("a");console.log(Object.keys(process.env).filter(k=>/E2E_/.test(k)).length);setInterval(()=>{},1000)';
  const s = stream([process.execPath, '-e', script], (l) => {
    lines.push(l);
    if (lines.length === 2) s.stop();
  });
  await s.closed;
  deepEqual(lines, ['a', '0']);
  s.stop();
});

test('extra child variables are set after the filter, but never GH_TOKEN or E2E_*', async () => {
  deepEqual(childEnv({ PATH: '/bin', E2E_X: 's' }, undefined, { PATH: '/only', XDG_DATA_HOME: '/d' }), { PATH: '/only', XDG_DATA_HOME: '/d' });
  deepEqual(childEnv({ Path: 'C:\\bin' }, undefined, { PATH: 'C:\\only' }, 'win32'), { Path: 'C:\\only' });
  throws(() => childEnv({}, undefined, { GH_TOKEN: 'x' }), /GH_TOKEN cannot be set/);
  throws(() => childEnv({}, undefined, { e2e_sandbox_token: 'x' }), /e2e_sandbox_token cannot be set/);
  const exec = createExec({ ...process.env }, () => {});
  await rejects(exec([process.execPath, '-e', '0'], { env: { E2E_CLAUDE_TOKEN: 'x' } }), /cannot be set/);
  const r = await exec([process.execPath, '-e', 'console.log(process.env.NIBFIN_E2E_X)'], { env: { NIBFIN_E2E_X: 'y' } });
  equal(r.stdout.trim(), 'y');
});
