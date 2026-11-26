import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { childEnv, createExec, mustRun, resolveArgv } from '../../src/host/exec.ts';

test('children get no E2E_* variable and no inherited GH_TOKEN; GH_TOKEN only when given', () => {
  const env = { PATH: '/bin', E2E_SANDBOX_TOKEN: 's', e2e_claude_token: 'c', GH_TOKEN: 'old' };
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
